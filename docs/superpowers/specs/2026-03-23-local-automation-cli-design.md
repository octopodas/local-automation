# Local Automation CLI — Design Spec

## Purpose

A Node.js CLI tool (`local-auto`) that automates browser-based data extraction from configured web dashboards using AI-driven navigation. It runs as a daemon with cron scheduling, file-based result storage, and a webhook API for external consumers. The CLI interface is designed for both human use and programmatic use by tools like Claude Code.

## Architecture

**Monolithic daemon with isolated task workers.**

The daemon is a single Node.js process with three subsystems:

1. **HTTP API (Fastify)** — handles CLI commands, webhook subscriptions, status queries
2. **Scheduler (node-cron)** — triggers tasks on configured cron schedules
3. **Task Manager** — spawns worker child processes, tracks status, handles retries, delivers results

**Task workers** run as isolated child processes. Each worker:
- Launches a Playwright browser instance
- Uses AI (Anthropic or Gemini, configurable) to navigate the site and extract data
- Returns results via IPC to the daemon
- Is stateless — all config passed at spawn time
- Can be retried cleanly on failure (fresh process each attempt)

**CLI client** (`local-auto`) is a thin commander-based wrapper that sends HTTP requests to the daemon on localhost and formats output for stdout.

```
Daemon (long-running)
├── Fastify HTTP API (:3847)
├── node-cron Scheduler
└── Task Manager
    └── spawns → Worker child processes
                 ├── Playwright browser
                 └── AI provider (Anthropic/Gemini)

CLI client → HTTP → Daemon
```

## Daemon Lifecycle

**Daemonization:** `local-auto start` spawns the daemon via `child_process.spawn({ detached: true, stdio: 'ignore' })` and immediately exits. The daemon writes its PID to `~/.local-auto/daemon.pid`.

**Double-start prevention:** Before spawning, `start` checks the PID file. If a process with that PID is running, it exits with a message. If the PID file exists but the process is dead, it cleans up the stale PID file and starts fresh.

**Graceful shutdown:** `local-auto stop` sends `SIGTERM` to the daemon PID. The daemon:
1. Stops accepting new task executions and scheduled triggers
2. Waits up to 30s for in-progress workers to finish
3. Force-kills any remaining workers after timeout
4. Completes pending webhook deliveries (5s grace)
5. Writes final state, removes PID file, exits

**Logging:** Daemon logs via pino to `~/.local-auto/daemon.log`. Rotated by size (10MB max, 3 files kept).

**Auth token:** On first start, the daemon generates a random bearer token and writes it to `~/.local-auto/auth-token` (mode 0600). All HTTP API requests require `Authorization: Bearer <token>`. The CLI reads this file automatically.

**Data directory:** `~/.local-auto/` contains:
- `daemon.pid` — process ID
- `daemon.log` — log output
- `auth-token` — API bearer token
- `state.json` — runtime state (webhook subscribers, task history)

## State Management

`state.json` is the daemon's runtime state file at `~/.local-auto/state.json`.

**Contents:**
- Webhook subscribers (id, url, filters)
- Last run timestamp per task
- Delivery log (last 50 entries)

**Write strategy:** Only the daemon writes to state. Writes use atomic rename (write to `.state.json.tmp`, then `rename()`). CLI reads state only via the HTTP API, never directly.

**Config reload:** v1 requires a daemon restart to pick up config changes. A future `local-auto reload` command may be added.

## Configuration

Single `config.yaml` file with env var interpolation for secrets.

```yaml
daemon:
  port: 3847
  host: 127.0.0.1

ai:
  provider: anthropic      # or "gemini"
  model: claude-sonnet-4-6
  # API keys from env: ANTHROPIC_API_KEY / GEMINI_API_KEY

sites:
  - name: my-dashboard
    url: https://dashboard.example.com
    login:
      type: form
      usernameField: "#email"
      passwordField: "#password"
      submitButton: "#login-btn"
      credentials:
        username: ${DASHBOARD_USER}
        password: ${DASHBOARD_PASS}
    tasks:
      - name: pull-metrics
        schedule: "0 */6 * * *"
        prompt: "Navigate to the metrics page, extract the daily active users count and revenue figures"
        output:
          webhooks: true
        retry:
          maxAttempts: 3
          backoffMs: 5000

webhooks:
  subscribers: []  # populated via API at runtime
```

**Config file location:** The daemon looks for `config.yaml` in the following order:
1. Path specified via `--config <path>` CLI flag
2. `./config.yaml` (current working directory)
3. `~/.local-auto/config.yaml`

The daemon records the resolved config path at startup and sets its working directory to the config file's parent directory. All relative paths in the config (e.g., `results/`) resolve relative to this directory.

Validated at load time with zod schemas. Env vars resolved via `${VAR_NAME}` syntax in YAML values. Credentials stored in `.env` file (gitignored).

## CLI Commands

```
local-auto start                    # Start the daemon
local-auto stop                     # Stop the daemon
local-auto status                   # Daemon status, running tasks, schedules

local-auto run <site> <task>        # Run task immediately, print result to stdout
local-auto list sites               # List configured sites
local-auto list tasks               # List all tasks across sites
local-auto list schedules           # Show cron schedules and next run times

local-auto logs [--task <name>]     # Show recent task results
local-auto logs --tail              # Follow new results

local-auto webhook add <url>        # Subscribe a webhook endpoint
local-auto webhook remove <url>     # Unsubscribe
local-auto webhook list             # List subscribers
local-auto webhook test <url>       # Send test payload

local-auto version                  # Print version
```

All commands support `--format json` for machine-readable output. Exit codes: 0 = success, 1 = task failure, 2 = daemon not running.

## AI Browser Agent

### Input
Each AI call receives:
- **Screenshot** (PNG) of the current browser viewport
- **Simplified DOM snapshot** (accessibility tree or cleaned HTML) for reliable selector targeting
- **Task context**: site config, task prompt, action history so far

### Action Loop
1. Take screenshot + DOM snapshot
2. Send to AI with task prompt, action history, and any error from the previous action
3. AI returns an action (see schema below)
4. Execute the action via Playwright. If it fails (selector not found, timeout, etc.), capture the error message — it will be fed back to the AI on the next iteration.
5. Repeat from step 1 until `done` or max iterations reached. Failed actions consume an iteration.

### AI Action Schema
```typescript
type AIAction =
  | { action: "click"; selector: string }
  | { action: "type"; selector: string; text: string }
  | { action: "select"; selector: string; value: string }  // dropdowns
  | { action: "navigate"; url: string }
  | { action: "scroll"; direction: "up" | "down" | "left" | "right"; amount?: number }
  | { action: "wait"; ms: number }
  | { action: "extract"; selector: string; format: "text" | "html" | "table" }
  | { action: "done"; result: Record<string, unknown>; summary: string }

// extract returns:
// - "text": textContent of the element
// - "html": innerHTML
// - "table": array of row objects (headers as keys)
```

The AI returns a JSON object matching one of these shapes. The `done` action's `result` is free-form JSON — the AI structures it based on the task prompt.

### Constraints
- Max iterations per task: configurable, default 20
- Max concurrent workers: configurable, default 2 (Playwright is ~200-500MB per instance)
- Login phase uses config hints (selectors) as guidance but AI adapts if page differs
- Concurrency: if a task is already running (scheduled overlaps manual), the second request is queued

### Provider Abstraction
```typescript
interface AIProvider {
  analyzeScreenshot(screenshot: Buffer, dom: string, context: TaskContext): Promise<AIAction>;
}
```
Implementations: `AnthropicProvider`, `GeminiProvider`. Selected via `ai.provider` config.

### DOM Snapshot Strategy
Use Playwright's `page.accessibility.snapshot()` to get the accessibility tree, serialized as a simplified text representation. This is more token-efficient than raw HTML and provides semantic structure. Fallback: if the accessibility tree is empty or too small, use a cleaned HTML snapshot (strip scripts/styles, limit to 50KB).

### Login Session Management
- After successful login, save Playwright `storageState` (cookies + localStorage) to `~/.local-auto/sessions/<site-name>.json`
- On subsequent runs, attempt to restore the session first. If it's expired (detected by the AI seeing a login page again), re-login and update the stored session.
- Login success detection: the AI verifies the post-login page matches expected content (no login form visible).
- MFA/OAuth/SSO: out of scope for v1. Only form-based login with username/password is supported.

## Worker IPC Protocol

Workers communicate with the daemon via Node.js `process.send()` / `process.on('message')` (IPC channel).

**Message types (worker → daemon):**
```typescript
type WorkerMessage =
  | { type: "progress"; iteration: number; action: string; screenshot?: string }
  | { type: "result"; success: true; data: Record<string, unknown>; summary: string }
  | { type: "error"; message: string; code: string; retryable: boolean }
```

**Message types (daemon → worker):**
```typescript
type DaemonMessage =
  | { type: "execute"; taskConfig: TaskConfig; siteConfig: SiteConfig }
  | { type: "cancel" }
```

**Watchdog:** If the daemon receives no message from a worker for 120 seconds, it kills the worker and retries (if retries remain).

**Retry semantics:**
- `maxAttempts: 3` means 3 total attempts (first try + 2 retries)
- `backoffMs: 5000` is the initial delay; each retry doubles it (5s, 10s, 20s)
- Retryable errors: worker crash, browser crash, AI API timeout/rate-limit, network errors
- Non-retryable errors: config validation failure, missing credentials, AI returns unparseable response after 3 consecutive attempts within a single run

## HTTP API Routes

All routes require `Authorization: Bearer <token>` header.

```
POST   /api/tasks/run          { site, task }              → { taskId, status }
GET    /api/tasks/:taskId       —                           → { status, result? }
GET    /api/tasks               —                           → [{ taskId, site, task, status }]

GET    /api/sites               —                           → [{ name, url, tasks }]
GET    /api/schedules           —                           → [{ site, task, cron, nextRun }]

GET    /api/logs                ?task=&site=&last=5         → [{ timestamp, result }]
GET    /api/logs/stream         SSE stream                  → event: log\ndata: {...}

POST   /api/webhooks            { url, filters? }           → { id, url }
DELETE /api/webhooks/:id        —                           → { ok: true }
GET    /api/webhooks            —                           → [{ id, url, filters }]
POST   /api/webhooks/:id/test   —                           → { delivered: boolean }

GET    /api/status              —                           → { uptime, tasks, workers }
GET    /health                  —                           → 200 { ok: true }
```

`GET /api/logs/stream` uses Server-Sent Events (SSE) for `local-auto logs --tail`.

## Webhook System

### Subscribers
- Register via CLI or HTTP API (`POST /api/webhooks`)
- Each subscriber has: unique ID, URL, optional filters `{ sites?: string[], tasks?: string[], events?: ("task.completed" | "task.failed")[] }`
- Persisted in `state.json`, survives daemon restarts

### Payload
```json
{
  "event": "task.completed",
  "timestamp": "2026-03-23T14:30:00Z",
  "task": {
    "site": "my-dashboard",
    "name": "pull-metrics",
    "triggeredBy": "schedule"
  },
  "result": {
    "success": true,
    "data": {},
    "summary": "Extracted DAU: 12,450 and revenue: $34,200",
    "duration_ms": 8500,
    "retries": 0
  }
}
```

Failure events use `"event": "task.failed"` with error details.

### Delivery
- Fire-and-forget POST with 10s timeout
- 3 retries with exponential backoff on delivery failure
- Delivery status logged but doesn't affect task success

## File Output

- All results written to `results/<site>/<task>/<timestamp>.json` (always, for every task)
- Latest result also symlinked at `results/<site>/<task>/latest.json`
- Configurable retention (default: last 100 results per task)
- The `results/` directory is relative to the project root (configurable via `daemon.resultsDir` in config)

## Project Structure

```
local-automation/
├── package.json
├── tsconfig.json
├── .env.example
├── config.yaml.example
├── src/
│   ├── cli/
│   │   ├── index.ts            # CLI entry point (commander)
│   │   └── commands/
│   │       ├── start.ts
│   │       ├── stop.ts
│   │       ├── status.ts
│   │       ├── run.ts
│   │       ├── list.ts
│   │       ├── logs.ts
│   │       └── webhook.ts
│   ├── daemon/
│   │   ├── index.ts            # Daemon entry point
│   │   ├── server.ts           # Fastify HTTP server
│   │   ├── scheduler.ts        # Cron schedule manager
│   │   ├── task-manager.ts     # Spawns & manages workers
│   │   └── webhook-manager.ts  # Subscriber mgmt & delivery
│   ├── worker/
│   │   ├── index.ts            # Worker entry point (child process)
│   │   ├── browser-agent.ts    # Playwright + AI action loop
│   │   └── actions.ts          # Action execution (click, type, etc.)
│   ├── ai/
│   │   ├── provider.ts         # AIProvider interface
│   │   ├── anthropic.ts        # Anthropic implementation
│   │   └── gemini.ts           # Gemini implementation
│   ├── config/
│   │   ├── loader.ts           # YAML config loading + env resolution
│   │   └── schema.ts           # Config validation (zod)
│   └── shared/
│       ├── types.ts            # Shared type definitions
│       └── logger.ts           # Logging utility (pino)
├── results/                    # Task output directory
└── tests/
```

## Dependencies

- `commander` — CLI framework
- `fastify` — HTTP server
- `node-cron` — Cron scheduling
- `playwright` — Browser automation
- `@anthropic-ai/sdk` — Anthropic API client
- `@google/generative-ai` — Gemini API client
- `zod` — Schema validation
- `yaml` — YAML parsing
- `pino` — Structured logging
- `dotenv` — Environment variable loading

## Error Handling

- **Worker crash:** Task Manager catches exit, retries per policy, logs failure
- **AI timeout/error:** Worker catches, returns error result, Task Manager retries
- **AI API network error:** Retryable — worker reports error, Task Manager respawns
- **Daemon crash:** CLI detects "daemon not running" (exit code 2), user restarts. PID file may be stale — `start` handles this.
- **Config errors:** Caught at startup with clear validation messages from zod
- **Missing config file:** First-run experience — CLI prints setup instructions pointing to `config.yaml.example`
- **Unwritable results directory:** Daemon logs error at startup, fails fast
- **Playwright not installed:** Detected at worker startup, clear error message with `npx playwright install` instructions
- **Webhook delivery failure:** Logged, retried 3x, does not block task completion

## Scope Boundaries (v1)

**In scope:** Form-based login, AI-driven navigation and extraction, cron scheduling, webhook delivery, file output, Anthropic + Gemini providers.

**Out of scope for v1:** OAuth/SSO/MFA login flows, config hot-reload, browser instance pooling, screenshot archival for debugging, distributed workers, task dependency chains.
