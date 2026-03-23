import { type Command } from "commander";
import { apiRequest, getFormat, output } from "../client.js";

export function registerListCommand(program: Command): void {
  const list = program
    .command("list")
    .description("List sites, tasks, or schedules");

  list
    .command("sites")
    .description("List configured sites")
    .action(async function (this: Command) {
      const format = getFormat(this);
      try {
        const { data } = await apiRequest("GET", "/api/sites");
        const sites = data as Array<{
          name: string;
          url: string;
          tasks: Array<{ name: string; schedule?: string; prompt: string }>;
        }>;

        if (format === "json") {
          output(sites, format);
        } else {
          for (const site of sites) {
            console.log(`${site.name} (${site.url})`);
            for (const task of site.tasks) {
              const sched = task.schedule ? ` [${task.schedule}]` : "";
              console.log(`  - ${task.name}${sched}`);
            }
          }
        }
      } catch (err) {
        console.error(`Failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  list
    .command("tasks")
    .description("List all tasks across sites")
    .action(async function (this: Command) {
      const format = getFormat(this);
      try {
        const { data } = await apiRequest("GET", "/api/sites");
        const sites = data as Array<{
          name: string;
          tasks: Array<{ name: string; schedule?: string; prompt: string }>;
        }>;

        const tasks = sites.flatMap((s) =>
          s.tasks.map((t) => ({ site: s.name, ...t }))
        );

        if (format === "json") {
          output(tasks, format);
        } else {
          for (const t of tasks) {
            const sched = t.schedule ? ` (${t.schedule})` : " (manual)";
            console.log(`${t.site}/${t.name}${sched}`);
            console.log(`  ${t.prompt}`);
          }
        }
      } catch (err) {
        console.error(`Failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  list
    .command("schedules")
    .description("Show cron schedules and next run times")
    .action(async function (this: Command) {
      const format = getFormat(this);
      try {
        const { data } = await apiRequest("GET", "/api/schedules");
        const schedules = data as Array<{
          site: string;
          task: string;
          schedule: string;
        }>;

        if (format === "json") {
          output(schedules, format);
        } else {
          if (schedules.length === 0) {
            console.log("No scheduled tasks");
            return;
          }
          for (const s of schedules) {
            console.log(`${s.site}/${s.task}: ${s.schedule}`);
          }
        }
      } catch (err) {
        console.error(`Failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
