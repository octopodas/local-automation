import { type Command } from "commander";
import { apiRequest, getFormat, output, getDaemonPid } from "../client.js";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show daemon status")
    .action(async function (this: Command) {
      const format = getFormat(this);
      const pid = getDaemonPid();

      if (!pid) {
        if (format === "json") {
          output({ running: false }, format);
        } else {
          console.log("Daemon is not running");
        }
        process.exit(2);
      }

      try {
        const { data } = await apiRequest("GET", "/api/status");
        const status = data as {
          uptime: number;
          tasks: number;
          workers: number;
          schedules: number;
        };

        if (format === "json") {
          output({ running: true, pid, ...status }, format);
        } else {
          console.log(`Daemon running (PID ${pid})`);
          console.log(`  Uptime:    ${formatUptime(status.uptime)}`);
          console.log(`  Tasks:     ${status.tasks} running`);
          console.log(`  Workers:   ${status.workers} active`);
          console.log(`  Schedules: ${status.schedules} registered`);
        }
      } catch (err) {
        console.error(`Failed to get status: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}
