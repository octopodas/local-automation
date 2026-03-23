import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TaskManager } from "../../src/daemon/task-manager.js";
import { createLogger } from "../../src/shared/logger.js";
import type { SiteConfig, TaskConfig, AIConfig } from "../../src/shared/types.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";

// We test the task manager's state management and queueing logic
// without actually spawning workers (which require the full worker module)

const logger = createLogger({ name: "test", level: "silent" });

const aiConfig: AIConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  maxIterations: 20,
};

const siteConfig: SiteConfig = {
  name: "test-site",
  url: "https://example.com",
  tasks: [],
};

const taskConfig: TaskConfig = {
  name: "test-task",
  prompt: "Extract data",
  output: { webhooks: false },
  retry: { maxAttempts: 3, backoffMs: 100 },
};

describe("TaskManager", () => {
  let tmpDir: string;
  let tm: TaskManager;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `local-auto-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    tm = new TaskManager({
      maxConcurrent: 2,
      aiConfig,
      logger,
      resultsDir: join(tmpDir, "results"),
    });
  });

  afterEach(async () => {
    await tm.shutdown(1000);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates task runs with unique IDs", async () => {
    // runTask will try to fork a worker which won't exist in test context,
    // so we catch the error but check that the task run was created
    const promise = tm.runTask(siteConfig, taskConfig, "manual");

    // Give it a moment to create the task run
    await new Promise((r) => setTimeout(r, 100));

    const tasks = tm.getAllTasks();
    expect(tasks.length).toBe(1);
    expect(tasks[0].site).toBe("test-site");
    expect(tasks[0].task).toBe("test-task");
    expect(tasks[0].triggeredBy).toBe("manual");
    expect(tasks[0].id).toBeTruthy();

    // Clean up — the worker will fail
    promise.catch(() => {});
    await tm.shutdown(500);
  });

  it("tracks task run status", async () => {
    const promise = tm.runTask(siteConfig, taskConfig, "schedule");
    await new Promise((r) => setTimeout(r, 100));

    const tasks = tm.getAllTasks();
    expect(tasks[0].status).toMatch(/running|failed|retrying/);

    promise.catch(() => {});
    await tm.shutdown(500);
  });

  it("getTaskRun returns undefined for unknown ID", () => {
    expect(tm.getTaskRun("nonexistent")).toBeUndefined();
  });

  it("getRunningTasks returns empty array initially", () => {
    expect(tm.getRunningTasks()).toEqual([]);
  });

  it("shutdown clears task queue", async () => {
    await tm.shutdown(100);
    // Should not throw
    expect(tm.getRunningTasks()).toEqual([]);
  });
});
