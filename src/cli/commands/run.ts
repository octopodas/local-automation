import { type Command } from "commander";
import { apiRequest, getFormat, output } from "../client.js";

interface ProgressEntry {
  iteration: number;
  step: string;
  message: string;
  thinking?: string;
  timestamp: string;
}

const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

function prefix(entry: ProgressEntry): string {
  if (entry.iteration === 0) return "";
  return `[${entry.iteration}] `;
}

function displayProgress(entries: ProgressEntry[], startIndex: number): void {
  for (let i = startIndex; i < entries.length; i++) {
    const entry = entries[i];
    const pfx = prefix(entry);

    switch (entry.step) {
      case "navigate":
        console.log(`${CYAN}${pfx}${entry.message}${RESET}`);
        break;

      case "session":
        console.log(`${DIM}${pfx}${entry.message}${RESET}`);
        break;

      case "capture":
        console.log(`${DIM}${pfx}${entry.message}${RESET}`);
        break;

      case "login-detect":
        console.log(`${YELLOW}${pfx}${entry.message}${RESET}`);
        break;

      case "ai-request":
        console.log(`${DIM}${pfx}${entry.message}${RESET}`);
        break;

      case "ai-response":
        if (entry.thinking) {
          console.log(`\n${DIM}${pfx}Thinking:${RESET}`);
          for (const line of entry.thinking.split("\n")) {
            console.log(`${DIM}  ${line}${RESET}`);
          }
        }
        console.log(`${CYAN}${pfx}Action: ${entry.message}${RESET}`);
        break;

      case "action-result":
        if (entry.message.startsWith("Action failed")) {
          console.log(`${RED}${pfx}${entry.message}${RESET}`);
        } else {
          console.log(`${GREEN}${pfx}${entry.message}${RESET}`);
        }
        break;

      default:
        console.log(`${pfx}${entry.message}`);
    }
  }
}

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
        let progressShown = 0;

        while (Date.now() - start < maxWait) {
          await new Promise((r) => setTimeout(r, 2000));

          const { data: taskData } = await apiRequest(
            "GET",
            `/api/tasks/${taskId}`
          );
          const run = taskData as {
            status: string;
            progress?: ProgressEntry[];
            result?: { success: boolean; data: unknown; summary: string };
            error?: string;
          };

          // Display new progress entries (including thinking)
          if (format !== "json" && run.progress && run.progress.length > progressShown) {
            displayProgress(run.progress, progressShown);
            progressShown = run.progress.length;
          }

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
        }

        console.error("\nTask did not complete within 5 minutes");
        process.exit(1);
      } catch (err) {
        console.error(`Failed to run task: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
