import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "../../src/daemon/server.js";
import { TaskManager } from "../../src/daemon/task-manager.js";
import { WebhookManager } from "../../src/daemon/webhook-manager.js";
import { Scheduler } from "../../src/daemon/scheduler.js";
import { createLogger } from "../../src/shared/logger.js";
import type { AppConfig } from "../../src/shared/types.js";
import type { FastifyInstance } from "fastify";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";

const logger = createLogger({ name: "test", level: "silent" });
const AUTH_TOKEN = "test-token-12345";

const testConfig: AppConfig = {
  daemon: { port: 3847, host: "127.0.0.1", maxConcurrentWorkers: 2 },
  ai: { provider: "anthropic", model: "claude-sonnet-4-6", maxIterations: 20 },
  sites: [
    {
      name: "test-site",
      url: "https://example.com",
      tasks: [
        {
          name: "test-task",
          prompt: "Extract data",
          output: { webhooks: false },
          retry: { maxAttempts: 3, backoffMs: 5000 },
        },
      ],
    },
  ],
};

describe("HTTP Server", () => {
  let tmpDir: string;
  let app: FastifyInstance;
  let taskManager: TaskManager;
  let webhookManager: WebhookManager;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `local-auto-server-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    taskManager = new TaskManager({
      maxConcurrent: 2,
      aiConfig: testConfig.ai,
      logger,
      resultsDir: join(tmpDir, "results"),
    });

    webhookManager = new WebhookManager(join(tmpDir, "state.json"), logger);
    const scheduler = new Scheduler(taskManager, webhookManager, logger);

    app = createServer({
      config: testConfig,
      taskManager,
      webhookManager,
      scheduler,
      authToken: AUTH_TOKEN,
      logger,
      startedAt: new Date(),
    });
  });

  afterEach(async () => {
    await taskManager.shutdown(1000);
    await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("GET /health returns 200 without auth", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it("rejects unauthenticated requests", async () => {
    const res = await app.inject({ method: "GET", url: "/api/status" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects wrong auth token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET /api/status returns daemon status", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("uptime");
    expect(body).toHaveProperty("tasks");
  });

  it("GET /api/sites returns configured sites", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/sites",
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("test-site");
    expect(body[0].tasks[0].name).toBe("test-task");
  });

  it("GET /api/tasks returns empty array initially", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/tasks",
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it("POST /api/tasks/run returns 404 for unknown site", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/run",
      headers: {
        authorization: `Bearer ${AUTH_TOKEN}`,
        "content-type": "application/json",
      },
      payload: { site: "nonexistent", task: "test" },
    });
    expect(res.statusCode).toBe(404);
  });

  // --- Webhook CRUD ---

  it("POST /api/webhooks creates a subscriber", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks",
      headers: {
        authorization: `Bearer ${AUTH_TOKEN}`,
        "content-type": "application/json",
      },
      payload: { url: "https://example.com/hook" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBeTruthy();
    expect(body.url).toBe("https://example.com/hook");
  });

  it("GET /api/webhooks returns subscribers", async () => {
    // Add a subscriber first
    await app.inject({
      method: "POST",
      url: "/api/webhooks",
      headers: {
        authorization: `Bearer ${AUTH_TOKEN}`,
        "content-type": "application/json",
      },
      payload: { url: "https://example.com/hook" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/webhooks",
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
  });

  it("DELETE /api/webhooks/:id removes a subscriber", async () => {
    // Add then remove
    const addRes = await app.inject({
      method: "POST",
      url: "/api/webhooks",
      headers: {
        authorization: `Bearer ${AUTH_TOKEN}`,
        "content-type": "application/json",
      },
      payload: { url: "https://example.com/hook" },
    });
    const { id } = JSON.parse(addRes.body);

    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/webhooks/${id}`,
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(delRes.statusCode).toBe(200);
    expect(JSON.parse(delRes.body)).toEqual({ ok: true });

    // Verify it's gone
    const listRes = await app.inject({
      method: "GET",
      url: "/api/webhooks",
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(JSON.parse(listRes.body)).toHaveLength(0);
  });

  it("GET /api/logs returns empty initially", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/logs",
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });
});
