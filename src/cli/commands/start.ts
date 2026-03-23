import { type Command } from "commander";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { getDaemonPid } from "../client.js";

const DATA_DIR = resolve(homedir(), ".local-auto");
const PID_PATH = resolve(DATA_DIR, "daemon.pid");
const __dirname = dirname(fileURLToPath(import.meta.url));

export function registerStartCommand(program: Command): void {
  program
    .command("start")
    .description("Start the daemon")
    .action(async () => {
      const configPath = program.opts().config;

      // Check if already running
      const pid = getDaemonPid();
      if (pid) {
        console.log(`Daemon is already running (PID ${pid})`);
        process.exit(0);
      }

      // Clean up stale PID file
      if (existsSync(PID_PATH)) {
        console.log("Cleaning up stale PID file...");
        const { unlinkSync } = await import("node:fs");
        unlinkSync(PID_PATH);
      }

      // Ensure data dir exists
      mkdirSync(DATA_DIR, { recursive: true });

      // Spawn the daemon detached
      const daemonPath = resolve(__dirname, "../daemon/index.js");
      const args: string[] = [];
      if (configPath) {
        args.push("--config", configPath);
      }

      const child = spawn("node", [daemonPath, ...args], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();

      console.log("Starting daemon...");

      // Wait for the daemon to be healthy
      const maxWait = 10_000;
      const start = Date.now();
      let healthy = false;

      while (Date.now() - start < maxWait) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const res = await fetch("http://127.0.0.1:3847/health");
          if (res.ok) {
            healthy = true;
            break;
          }
        } catch {
          // Not ready yet
        }
      }

      if (healthy) {
        const newPid = getDaemonPid();
        console.log(`Daemon started successfully (PID ${newPid ?? child.pid})`);
      } else {
        console.error("Daemon failed to start within 10 seconds. Check ~/.local-auto/daemon.log");
        process.exit(1);
      }
    });
}
