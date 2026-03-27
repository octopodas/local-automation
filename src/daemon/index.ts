import { resolve } from "node:path";
import { homedir } from "node:os";
import {
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../config/loader.js";
import { createLogger } from "../shared/logger.js";
import { TelegramNotifier } from "./telegram-notifier.js";
import { TaskManager } from "./task-manager.js";
import { WebhookManager } from "./webhook-manager.js";
import { Scheduler } from "./scheduler.js";
import { createServer } from "./server.js";

const DATA_DIR = resolve(homedir(), ".local-auto");
const PID_PATH = resolve(DATA_DIR, "daemon.pid");
const AUTH_TOKEN_PATH = resolve(DATA_DIR, "auth-token");
const STATE_PATH = resolve(DATA_DIR, "state.json");
const LOG_PATH = resolve(DATA_DIR, "daemon.log");

async function main(): Promise<void> {
  // Ensure data directory exists
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(resolve(DATA_DIR, "sessions"), { recursive: true });

  // Parse --config flag from argv
  const configFlag = process.argv.indexOf("--config");
  const configPath =
    configFlag !== -1 ? process.argv[configFlag + 1] : undefined;

  // Load config
  const { config, configDir } = loadConfig(configPath);

  // Set working directory to config dir (for relative paths)
  process.chdir(configDir);

  // Create logger
  const logger = createLogger({
    name: "daemon",
    filePath: LOG_PATH,
  });

  logger.info({ configDir, dataDir: DATA_DIR }, "Starting daemon");

  // Generate or read auth token
  let authToken: string;
  if (existsSync(AUTH_TOKEN_PATH)) {
    authToken = readFileSync(AUTH_TOKEN_PATH, "utf-8").trim();
  } else {
    authToken = randomBytes(32).toString("hex");
    writeFileSync(AUTH_TOKEN_PATH, authToken, { mode: 0o600 });
    logger.info("Generated new auth token");
  }

  // Write PID file
  writeFileSync(PID_PATH, String(process.pid));
  logger.info({ pid: process.pid }, "PID file written");

  // Ensure results directory exists
  const resultsDir = resolve(configDir, "results");
  mkdirSync(resultsDir, { recursive: true });

  // Initialize components
  const webhookManager = new WebhookManager(STATE_PATH, logger);

  const taskManager = new TaskManager({
    maxConcurrent: config.daemon.maxConcurrentWorkers,
    aiConfig: config.ai,
    logger,
    resultsDir,
  });

  const scheduler = new Scheduler(taskManager, webhookManager, logger);

  // Set up Telegram notifications
  if (config.notifications?.telegram) {
    const telegram = new TelegramNotifier(config.notifications.telegram, logger);
    taskManager.on("taskCompleted", (run, result) => {
      telegram.notify(run, result).catch(() => {});
    });
    taskManager.on("taskFailed", (run, result) => {
      telegram.notify(run, result).catch(() => {});
    });
    logger.info("Telegram notifications enabled");
  }

  // Create HTTP server
  const startedAt = new Date();
  const app = createServer({
    config,
    taskManager,
    webhookManager,
    scheduler,
    authToken,
    logger,
    startedAt,
  });

  // Start scheduler
  scheduler.start(config);

  // Start HTTP server
  await app.listen({
    port: config.daemon.port,
    host: config.daemon.host,
  });

  logger.info(
    { port: config.daemon.port, host: config.daemon.host },
    "Daemon listening"
  );

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutdown signal received");

    // Stop accepting new tasks
    scheduler.stop();

    // Wait for workers to finish
    await taskManager.shutdown(30_000);

    // Close HTTP server
    await app.close();

    // Save final state
    webhookManager.saveState();

    // Remove PID file
    try {
      unlinkSync(PID_PATH);
    } catch {
      // OK
    }

    logger.info("Daemon shut down cleanly");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  // stdio may be "ignore" when spawned by CLI, so also write to the log file
  const msg = err.code === "EADDRINUSE"
    ? `Port ${err.port ?? "unknown"} is already in use — is another daemon or process running?`
    : `Fatal error starting daemon: ${err.message}`;
  console.error(msg);
  try {
    appendFileSync(LOG_PATH, JSON.stringify({ level: 60, time: Date.now(), name: "daemon", msg }) + "\n");
  } catch {
    // Best-effort
  }
  process.exit(1);
});
