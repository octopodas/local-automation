import { type Command } from "commander";
import { apiRequest, getFormat, output } from "../client.js";

export function registerWebhookCommand(program: Command): void {
  const webhook = program
    .command("webhook")
    .description("Manage webhook subscribers");

  webhook
    .command("add <url>")
    .description("Subscribe a webhook endpoint")
    .option("--sites <sites>", "Comma-separated site filter")
    .option("--tasks <tasks>", "Comma-separated task filter")
    .option("--events <events>", "Comma-separated event filter (task.completed, task.failed)")
    .action(async function (this: Command, url: string) {
      const format = getFormat(this);
      const opts = this.opts() as {
        sites?: string;
        tasks?: string;
        events?: string;
      };

      const filters: Record<string, string[]> = {};
      if (opts.sites) filters.sites = opts.sites.split(",");
      if (opts.tasks) filters.tasks = opts.tasks.split(",");
      if (opts.events) filters.events = opts.events.split(",");

      try {
        const { data } = await apiRequest("POST", "/api/webhooks", {
          url,
          filters: Object.keys(filters).length > 0 ? filters : undefined,
        });
        const sub = data as { id: string; url: string };

        if (format === "json") {
          output(sub, format);
        } else {
          console.log(`Webhook subscriber added (ID: ${sub.id})`);
          console.log(`  URL: ${sub.url}`);
        }
      } catch (err) {
        console.error(`Failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  webhook
    .command("remove <url-or-id>")
    .description("Unsubscribe a webhook endpoint")
    .action(async function (this: Command, urlOrId: string) {
      const format = getFormat(this);

      try {
        // First try as ID directly
        let { status, data } = await apiRequest(
          "DELETE",
          `/api/webhooks/${urlOrId}`
        );

        if (status === 404) {
          // Try finding by URL
          const { data: subs } = await apiRequest("GET", "/api/webhooks");
          const found = (subs as Array<{ id: string; url: string }>).find(
            (s) => s.url === urlOrId
          );
          if (found) {
            const result = await apiRequest(
              "DELETE",
              `/api/webhooks/${found.id}`
            );
            status = result.status;
            data = result.data;
          } else {
            console.error("Subscriber not found");
            process.exit(1);
          }
        }

        if (format === "json") {
          output(data, format);
        } else {
          console.log("Webhook subscriber removed");
        }
      } catch (err) {
        console.error(`Failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  webhook
    .command("list")
    .description("List webhook subscribers")
    .action(async function (this: Command) {
      const format = getFormat(this);

      try {
        const { data } = await apiRequest("GET", "/api/webhooks");
        const subs = data as Array<{
          id: string;
          url: string;
          filters?: Record<string, string[]>;
          createdAt: string;
        }>;

        if (format === "json") {
          output(subs, format);
        } else {
          if (subs.length === 0) {
            console.log("No webhook subscribers");
            return;
          }
          for (const sub of subs) {
            console.log(`${sub.id}`);
            console.log(`  URL: ${sub.url}`);
            if (sub.filters) {
              console.log(`  Filters: ${JSON.stringify(sub.filters)}`);
            }
            console.log(`  Created: ${sub.createdAt}`);
          }
        }
      } catch (err) {
        console.error(`Failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  webhook
    .command("test <url-or-id>")
    .description("Send a test webhook payload")
    .action(async function (this: Command, urlOrId: string) {
      const format = getFormat(this);

      try {
        // Find the subscriber
        const { data: subs } = await apiRequest("GET", "/api/webhooks");
        const subList = subs as Array<{ id: string; url: string }>;
        const found =
          subList.find((s) => s.id === urlOrId) ??
          subList.find((s) => s.url === urlOrId);

        if (!found) {
          console.error("Subscriber not found");
          process.exit(1);
        }

        const { data } = await apiRequest(
          "POST",
          `/api/webhooks/${found.id}/test`
        );
        const result = data as {
          delivered: boolean;
          status?: number;
          error?: string;
        };

        if (format === "json") {
          output(result, format);
        } else {
          if (result.delivered) {
            console.log(`Test delivered successfully (HTTP ${result.status})`);
          } else {
            console.error(`Test delivery failed: ${result.error}`);
          }
        }
      } catch (err) {
        console.error(`Failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
