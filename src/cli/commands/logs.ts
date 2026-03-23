import { type Command } from "commander";
import { apiRequest, getFormat, output, getAuthToken, getDaemonUrl } from "../client.js";

export function registerLogsCommand(program: Command): void {
  program
    .command("logs")
    .description("Show recent task results")
    .option("--task <name>", "Filter by task name")
    .option("--site <name>", "Filter by site name")
    .option("--last <n>", "Number of recent results", "10")
    .option("--tail", "Follow new results in real-time")
    .action(async function (this: Command) {
      const format = getFormat(this);
      const opts = this.opts() as {
        task?: string;
        site?: string;
        last: string;
        tail?: boolean;
      };

      try {
        if (opts.tail) {
          await streamLogs();
          return;
        }

        const params = new URLSearchParams();
        if (opts.task) params.set("task", opts.task);
        if (opts.site) params.set("site", opts.site);
        params.set("last", opts.last);

        const { data } = await apiRequest(
          "GET",
          `/api/logs?${params.toString()}`
        );
        const logs = data as Array<{
          timestamp: string;
          site: string;
          task: string;
          status: string;
          result?: { summary?: string };
        }>;

        if (format === "json") {
          output(logs, format);
        } else {
          if (logs.length === 0) {
            console.log("No results yet");
            return;
          }
          for (const log of logs) {
            const status = log.status === "completed" ? "OK" : "FAIL";
            const summary = log.result?.summary ?? "";
            console.log(
              `[${log.timestamp}] ${log.site}/${log.task} ${status} — ${summary}`
            );
          }
        }
      } catch (err) {
        console.error(`Failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}

async function streamLogs(): Promise<void> {
  const token = getAuthToken();
  const url = `${getDaemonUrl()}/api/logs/stream`;

  console.log("Streaming logs (Ctrl+C to stop)...\n");

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok || !response.body) {
    console.error("Failed to connect to log stream");
    process.exit(1);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const text = decoder.decode(value, { stream: true });
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const data = JSON.parse(line.slice(6));
          console.log(JSON.stringify(data, null, 2));
        } catch {
          console.log(line.slice(6));
        }
      }
    }
  }
}
