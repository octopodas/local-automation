import cron from "node-cron";
import type { AppConfig, SiteConfig, TaskConfig } from "../shared/types.js";
import type { TaskManager } from "./task-manager.js";
import type { WebhookManager } from "./webhook-manager.js";
import type { Logger } from "pino";

interface ScheduledJob {
  site: string;
  task: string;
  schedule: string;
  cronTask: cron.ScheduledTask;
}

export class Scheduler {
  private jobs: ScheduledJob[] = [];
  private taskManager: TaskManager;
  private webhookManager: WebhookManager;
  private logger: Logger;

  constructor(
    taskManager: TaskManager,
    webhookManager: WebhookManager,
    logger: Logger
  ) {
    this.taskManager = taskManager;
    this.webhookManager = webhookManager;
    this.logger = logger;
  }

  /**
   * Register cron jobs for all tasks with schedules.
   */
  start(config: AppConfig): void {
    for (const site of config.sites) {
      for (const task of site.tasks) {
        if (!task.schedule) continue;

        if (!cron.validate(task.schedule)) {
          this.logger.error(
            { site: site.name, task: task.name, schedule: task.schedule },
            "Invalid cron expression, skipping"
          );
          continue;
        }

        const cronTask = cron.schedule(task.schedule, () => {
          this.executeScheduledTask(site, task);
        });

        this.jobs.push({
          site: site.name,
          task: task.name,
          schedule: task.schedule,
          cronTask,
        });

        this.logger.info(
          { site: site.name, task: task.name, schedule: task.schedule },
          "Scheduled task registered"
        );
      }
    }
  }

  private async executeScheduledTask(
    site: SiteConfig,
    task: TaskConfig
  ): Promise<void> {
    const taskKey = `${site.name}/${task.name}`;
    this.logger.info({ taskKey }, "Scheduled task triggered");

    try {
      const result = await this.taskManager.runTask(site, task, "schedule");
      this.webhookManager.updateLastRun(taskKey);

      if (task.output.webhooks) {
        await this.webhookManager.deliverEvent(
          result.success ? "task.completed" : "task.failed",
          {
            id: "",
            site: site.name,
            task: task.name,
            status: result.success ? "completed" : "failed",
            triggeredBy: "schedule",
            attempt: result.retries + 1,
            startedAt: new Date().toISOString(),
          },
          result
        );
      }
    } catch (err) {
      this.logger.error(
        { taskKey, error: (err as Error).message },
        "Scheduled task execution failed"
      );
    }
  }

  getSchedules(): Array<{
    site: string;
    task: string;
    schedule: string;
  }> {
    return this.jobs.map((j) => ({
      site: j.site,
      task: j.task,
      schedule: j.schedule,
    }));
  }

  stop(): void {
    for (const job of this.jobs) {
      job.cronTask.stop();
    }
    this.jobs = [];
    this.logger.info("All scheduled jobs stopped");
  }
}
