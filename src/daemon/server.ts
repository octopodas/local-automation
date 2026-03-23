import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import type { AppConfig } from "../shared/types.js";
import type { TaskManager } from "./task-manager.js";
import type { WebhookManager } from "./webhook-manager.js";
import type { Scheduler } from "./scheduler.js";
import type { Logger } from "pino";

interface ServerDeps {
  config: AppConfig;
  taskManager: TaskManager;
  webhookManager: WebhookManager;
  scheduler: Scheduler;
  authToken: string;
  logger: Logger;
  startedAt: Date;
}

export function createServer(deps: ServerDeps): FastifyInstance {
  const {
    config,
    taskManager,
    webhookManager,
    scheduler,
    authToken,
    logger,
    startedAt,
  } = deps;

  const app = Fastify({ logger: false });

  // Auth middleware — skip for /health
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url === "/health") return;

    const auth = request.headers.authorization;
    if (!auth || auth !== `Bearer ${authToken}`) {
      reply.code(401).send({ error: "Unauthorized" });
    }
  });

  // --- Health ---

  app.get("/health", async () => {
    return { ok: true };
  });

  // --- Status ---

  app.get("/api/status", async () => {
    return {
      uptime: Math.floor((Date.now() - startedAt.getTime()) / 1000),
      tasks: taskManager.getRunningTasks().length,
      workers: taskManager.getRunningTasks().length,
      schedules: scheduler.getSchedules().length,
    };
  });

  // --- Tasks ---

  app.post<{
    Body: { site: string; task: string };
  }>("/api/tasks/run", async (request, reply) => {
    const { site: siteName, task: taskName } = request.body;

    const siteConfig = config.sites.find((s) => s.name === siteName);
    if (!siteConfig) {
      reply.code(404).send({ error: `Site "${siteName}" not found` });
      return;
    }

    const taskConfig = siteConfig.tasks.find((t) => t.name === taskName);
    if (!taskConfig) {
      reply.code(404).send({ error: `Task "${taskName}" not found in site "${siteName}"` });
      return;
    }

    // Start the task asynchronously
    const runPromise = taskManager.runTask(siteConfig, taskConfig, "manual");

    // Get the task run that was just created
    const allTasks = taskManager.getAllTasks();
    const latestRun = allTasks[allTasks.length - 1];

    // Handle webhook delivery when task completes
    runPromise
      .then(async (result) => {
        webhookManager.updateLastRun(`${siteName}/${taskName}`);
        if (taskConfig.output.webhooks) {
          await webhookManager.deliverEvent("task.completed", latestRun, result);
        }
      })
      .catch(async (err) => {
        if (taskConfig.output.webhooks && latestRun.result) {
          await webhookManager.deliverEvent("task.failed", latestRun, latestRun.result);
        }
      });

    return { taskId: latestRun.id, status: latestRun.status };
  });

  app.get<{
    Params: { taskId: string };
  }>("/api/tasks/:taskId", async (request, reply) => {
    const run = taskManager.getTaskRun(request.params.taskId);
    if (!run) {
      reply.code(404).send({ error: "Task run not found" });
      return;
    }
    return run;
  });

  app.get("/api/tasks", async () => {
    return taskManager.getAllTasks().map((r) => ({
      taskId: r.id,
      site: r.site,
      task: r.task,
      status: r.status,
      triggeredBy: r.triggeredBy,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
    }));
  });

  // --- Sites ---

  app.get("/api/sites", async () => {
    return config.sites.map((s) => ({
      name: s.name,
      url: s.url,
      tasks: s.tasks.map((t) => ({
        name: t.name,
        schedule: t.schedule,
        prompt: t.prompt,
      })),
    }));
  });

  // --- Schedules ---

  app.get("/api/schedules", async () => {
    return scheduler.getSchedules();
  });

  // --- Logs ---

  app.get<{
    Querystring: { task?: string; site?: string; last?: string };
  }>("/api/logs", async (request) => {
    // Return recent task runs as logs
    let runs = taskManager.getAllTasks().filter(
      (r) => r.status === "completed" || r.status === "failed"
    );

    if (request.query.site) {
      runs = runs.filter((r) => r.site === request.query.site);
    }
    if (request.query.task) {
      runs = runs.filter((r) => r.task === request.query.task);
    }

    const limit = parseInt(request.query.last ?? "10", 10);
    runs = runs.slice(-limit);

    return runs.map((r) => ({
      timestamp: r.completedAt ?? r.startedAt,
      result: r.result,
      site: r.site,
      task: r.task,
      status: r.status,
    }));
  });

  // SSE endpoint for log streaming
  app.get("/api/logs/stream", async (request, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const onCompleted = (_run: unknown, result: unknown) => {
      reply.raw.write(`event: log\ndata: ${JSON.stringify(result)}\n\n`);
    };

    const onFailed = (_run: unknown, result: unknown) => {
      reply.raw.write(`event: log\ndata: ${JSON.stringify(result)}\n\n`);
    };

    taskManager.on("taskCompleted", onCompleted);
    taskManager.on("taskFailed", onFailed);

    request.raw.on("close", () => {
      taskManager.off("taskCompleted", onCompleted);
      taskManager.off("taskFailed", onFailed);
    });
  });

  // --- Webhooks ---

  app.post<{
    Body: { url: string; filters?: { sites?: string[]; tasks?: string[]; events?: string[] } };
  }>("/api/webhooks", async (request) => {
    const { url, filters } = request.body;
    const subscriber = webhookManager.addSubscriber(url, filters as any);
    return { id: subscriber.id, url: subscriber.url };
  });

  app.delete<{
    Params: { id: string };
  }>("/api/webhooks/:id", async (request, reply) => {
    const removed = webhookManager.removeSubscriber(request.params.id);
    if (!removed) {
      reply.code(404).send({ error: "Subscriber not found" });
      return;
    }
    return { ok: true };
  });

  app.get("/api/webhooks", async () => {
    return webhookManager.getSubscribers();
  });

  app.post<{
    Params: { id: string };
  }>("/api/webhooks/:id/test", async (request, reply) => {
    const subscriber = webhookManager.getSubscriber(request.params.id);
    if (!subscriber) {
      reply.code(404).send({ error: "Subscriber not found" });
      return;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const response = await fetch(subscriber.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "test",
          timestamp: new Date().toISOString(),
          message: "This is a test webhook delivery",
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return { delivered: response.ok, status: response.status };
    } catch (err) {
      return { delivered: false, error: (err as Error).message };
    }
  });

  return app;
}
