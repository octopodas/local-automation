import { type Command } from "commander";
import { apiRequest, getFormat, output } from "../client.js";

export function registerRunCommand(program: Command): void {
  program
    .command("run <site> <task>")
    .description("Run a task immediately")
    .action(async function (this: Command, site: string, task: string) {
      const format = getFormat(this);

      try {
        // Start the task
        const { status, data } = await apiRequest("POST", "/api/tasks/run", {
          site,
          task,
        });

        if (status === 404) {
          console.error((data as { error: string }).error);
          process.exit(1);
        }

        const { taskId } = data as { taskId: string; status: string };

        if (format !== "json") {
          console.log(`Task started (ID: ${taskId})`);
          console.log("Waiting for completion...");
        }

        // Poll for completion
        const maxWait = 300_000; // 5 minutes
        const start = Date.now();

        while (Date.now() - start < maxWait) {
          await new Promise((r) => setTimeout(r, 2000));

          const { data: taskData } = await apiRequest(
            "GET",
            `/api/tasks/${taskId}`
          );
          const run = taskData as {
            status: string;
            result?: { success: boolean; data: unknown; summary: string };
            error?: string;
          };

          if (run.status === "completed") {
            if (format === "json") {
              output(run.result, format);
            } else {
              console.log(`\nTask completed successfully`);
              if (run.result?.summary) {
                console.log(`Summary: ${run.result.summary}`);
              }
              console.log(`\nData:`);
              console.log(JSON.stringify(run.result?.data, null, 2));
            }
            return;
          }

          if (run.status === "failed") {
            if (format === "json") {
              output({ success: false, error: run.error }, format);
            } else {
              console.error(`\nTask failed: ${run.error}`);
            }
            process.exit(1);
          }

          if (format !== "json") {
            process.stdout.write(".");
          }
        }

        console.error("\nTask did not complete within 5 minutes");
        process.exit(1);
      } catch (err) {
        console.error(`Failed to run task: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
