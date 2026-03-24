# local-auto

AI-driven browser automation CLI tool for extracting data from web dashboards. Uses Playwright for browser control and AI (Anthropic Claude or Google Gemini) to navigate pages and extract structured data.

## How it works

A long-running daemon manages scheduled tasks. Each task spawns an isolated worker process that launches a headless browser, lets an AI model navigate the page via screenshots and DOM snapshots, and returns structured JSON results. Results are stored locally and optionally delivered via webhooks or Telegram notifications.

## Prerequisites

- Node.js 20+
- An API key for [Anthropic](https://console.anthropic.com/) or [Google Gemini](https://aistudio.google.com/apikey)

## Installation

```bash
git clone https://github.com/octopodas/local-automation.git
cd local-automation
npm install
npm run build
npm link   # makes `local-auto` available globally
```

Chromium is installed automatically via `postinstall`.

To unlink later: `npm unlink -g local-auto`.

## Configuration

### 1. API keys

```bash
cp .env.example .env
```

Edit `.env` and add your AI provider key:

```env
ANTHROPIC_API_KEY=sk-ant-...
# or
GEMINI_API_KEY=AI...
```

Add any site credentials referenced in your config:

```env
DASHBOARD_USER=your-username
DASHBOARD_PASS=your-password
```

### 2. Sites and tasks

```bash
cp config.yaml.example config.yaml
```

Edit `config.yaml` to define the sites you want to automate:

```yaml
daemon:
  port: 3847
  host: 127.0.0.1
  maxConcurrentWorkers: 2

ai:
  provider: anthropic       # "anthropic" or "gemini"
  model: claude-sonnet-4-6  # provider-specific model name
  maxIterations: 20

sites:
  - name: my-dashboard
    url: https://example.com/dashboard
    login:
      type: form
      usernameField: "#username"
      passwordField: "#password"
      submitButton: "#login-btn"
      credentials:
        username: ${DASHBOARD_USER}
        password: ${DASHBOARD_PASS}
    tasks:
      - name: pull-data
        schedule: "0 */6 * * *"       # every 6 hours
        prompt: "extract the revenue figures and user counts"
        output:
          webhooks: true
        retry:
          maxAttempts: 3
          backoffMs: 5000
```

Credentials use `${VAR_NAME}` syntax to reference environment variables from `.env`.

The config file is looked up in order: `--config <path>` flag, `./config.yaml`, `~/.local-auto/config.yaml`.

### 3. Telegram notifications (optional)

Add to your `config.yaml`:

```yaml
notifications:
  telegram:
    botToken: ${TELEGRAM_BOT_TOKEN}
    chatId: ${TELEGRAM_CHAT_ID}
```

And the corresponding values to `.env`.

## Usage

### Daemon

```bash
local-auto start              # start the daemon (background)
local-auto stop               # stop the daemon
local-auto status             # show daemon status and running tasks
```

### Running tasks

```bash
local-auto run my-dashboard pull-data   # run a task immediately
```

### Listing configuration

```bash
local-auto list sites         # configured sites
local-auto list tasks         # all tasks across sites
local-auto list schedules     # cron schedules with next run times
```

### Logs

```bash
local-auto logs               # recent task results
local-auto logs --task pull-data   # filter by task name
local-auto logs --tail         # follow new results in real time
```

### Webhooks

Subscribe external endpoints to receive task results:

```bash
local-auto webhook add https://example.com/hook
local-auto webhook list
local-auto webhook test https://example.com/hook
local-auto webhook remove https://example.com/hook
```

All commands support `--format json` for machine-readable output.

## Architecture

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

- **Daemon** — Fastify HTTP API, cron scheduler, task manager, webhook delivery
- **Workers** — isolated child processes, each with its own browser instance and AI session
- **CLI** — thin client that talks to the daemon over HTTP on localhost

## Development

```bash
npm run dev       # watch mode (tsx)
npm run build     # compile TypeScript
npm test          # run tests (vitest)
```

## License

MIT
