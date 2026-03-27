import { type Command } from "commander";
import { spawn, execSync } from "node:child_process";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { getDaemonPid } from "../client.js";
import { findConfigPath } from "../../config/loader.js";

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

      // Check if port is already in use
      const port = 3847;
      const portInUse = await new Promise<boolean>((resolveP) => {
        const sock = createConnection({ port, host: "127.0.0.1" });
        sock.once("connect", () => { sock.destroy(); resolveP(true); });
        sock.once("error", () => resolveP(false));
      });
      if (portInUse) {
        let extra = "";
        try {
          const out = execSync(`lsof -i :${port} -t 2>/dev/null`, { encoding: "utf-8" }).trim();
          if (out) extra = ` (held by PID ${out.split("\n")[0]})`;
        } catch { /* lsof not available */ }
        console.error(`Port ${port} is already in use${extra}. Kill the process or choose a different port.`);
        process.exit(1);
      }

      // Rebuild TypeScript before starting
      const projectRoot = resolve(__dirname, "../../..");
      console.log("Building...");
      try {
        execSync("npm run build", { cwd: projectRoot, stdio: "pipe" });
      } catch (err) {
        console.error("Build failed:");
        console.error((err as { stderr?: Buffer }).stderr?.toString().trim() ?? (err as Error).message);
        process.exit(1);
      }

      // Resolve config path now so the detached daemon can find it.
      // Also check the project root as a fallback (for global npm link installs).
      let resolvedConfigPath: string;
      try {
        resolvedConfigPath = findConfigPath(configPath);
      } catch {
        const projectConfig = resolve(projectRoot, "config.yaml");
        if (!configPath && existsSync(projectConfig)) {
          resolvedConfigPath = projectConfig;
        } else {
          console.error(
            "No config.yaml found. Looked in:\n" +
            `  1. ./config.yaml (cwd)\n` +
            `  2. ~/.local-auto/config.yaml\n` +
            `  3. ${projectRoot}/config.yaml (install dir)\n` +
            "Create one from config.yaml.example to get started."
          );
          process.exit(1);
        }
      }

      // Spawn the daemon detached
      const daemonPath = resolve(__dirname, "../../daemon/index.js");
      const args = ["--config", resolvedConfigPath];

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
        console.error("Daemon failed to start within 10 seconds.");
        // Show last few log lines for quick diagnosis
        const logPath = resolve(DATA_DIR, "daemon.log");
        if (existsSync(logPath)) {
          const logContent = readFileSync(logPath, "utf-8").trim();
          const lines = logContent.split("\n").slice(-5);
          if (lines.length > 0 && lines[0]) {
            console.error("\nRecent log entries:");
            for (const line of lines) {
              try {
                const entry = JSON.parse(line);
                const lvl = entry.level >= 50 ? "ERROR" : entry.level >= 40 ? "WARN" : "INFO";
                console.error(`  [${lvl}] ${entry.msg}`);
              } catch {
                console.error(`  ${line}`);
              }
            }
          }
        }
        console.error("\nFull log: ~/.local-auto/daemon.log");
        process.exit(1);
      }
    });
}
