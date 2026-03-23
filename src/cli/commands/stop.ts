import { type Command } from "commander";
import { getDaemonPid } from "../client.js";

export function registerStopCommand(program: Command): void {
  program
    .command("stop")
    .description("Stop the daemon")
    .action(async () => {
      const pid = getDaemonPid();
      if (!pid) {
        console.log("Daemon is not running");
        process.exit(2);
      }

      console.log(`Stopping daemon (PID ${pid})...`);

      try {
        process.kill(pid, "SIGTERM");
      } catch (err) {
        console.error(`Failed to send SIGTERM: ${(err as Error).message}`);
        process.exit(1);
      }

      // Wait for the process to exit
      const maxWait = 35_000; // 30s graceful + 5s buffer
      const start = Date.now();

      while (Date.now() - start < maxWait) {
        await new Promise((r) => setTimeout(r, 500));
        if (!getDaemonPid()) {
          console.log("Daemon stopped");
          return;
        }
      }

      console.error("Daemon did not stop within timeout");
      process.exit(1);
    });
}
