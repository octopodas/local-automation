# local-auto

AI-driven browser automation CLI tool for extracting data from web dashboards.

## Quick Start

```bash
npm install
cp .env.example .env          # Add your API keys
cp config.yaml.example config.yaml  # Configure your sites
npm run build
npm link                      # Make `local-auto` available globally
local-auto start              # Start the daemon
```

To unlink: `npm unlink -g local-auto`.

## Development

```bash
npm run build    # Compile TypeScript
npm test         # Run tests (vitest)
npm run dev      # Dev mode with watch
```

## Architecture

- **Daemon** (`src/daemon/`) — Fastify HTTP API, node-cron scheduler, task manager
- **Worker** (`src/worker/`) — Isolated child processes running Playwright + AI
- **CLI** (`src/cli/`) — Commander-based client that talks to daemon via HTTP
- **AI** (`src/ai/`) — Anthropic and Gemini provider implementations
- **Config** (`src/config/`) — YAML config with env var interpolation, zod validation

## Key Files

- `src/daemon/index.ts` — Daemon entry point
- `src/cli/index.ts` — CLI entry point
- `src/worker/browser-agent.ts` — Core AI action loop
- `src/daemon/task-manager.ts` — Worker spawning, retry, watchdog
- `src/daemon/server.ts` — HTTP API routes
- `src/config/schema.ts` — Zod schemas for config and AI actions
- `src/daemon/telegram-notifier.ts` — Telegram notification delivery

## Config

Config file is `config.yaml` (looked up in cwd then `~/.local-auto/`).
Credentials use env var interpolation: `${VAR_NAME}`.
API keys go in `.env` file.
Telegram notifications configured via `notifications.telegram` in config.

## CLI Commands

```
local-auto start|stop|status
local-auto run <site> <task>
local-auto list sites|tasks|schedules
local-auto logs [--tail] [--task <name>]
local-auto webhook add|remove|list|test
```

All commands support `--format json`.

## Testing

Tests use vitest with mocked dependencies. Run with `npm test`.
