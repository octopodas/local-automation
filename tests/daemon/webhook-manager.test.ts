import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebhookManager } from "../../src/daemon/webhook-manager.js";
import { createLogger } from "../../src/shared/logger.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";
import type { TaskRun, TaskResult } from "../../src/shared/types.js";

const logger = createLogger({ name: "test", level: "silent" });

describe("WebhookManager", () => {
  let tmpDir: string;
  let statePath: string;
  let wm: WebhookManager;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `local-auto-webhook-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    statePath = join(tmpDir, "state.json");
    wm = new WebhookManager(statePath, logger);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("subscriber CRUD", () => {
    it("adds a subscriber", () => {
      const sub = wm.addSubscriber("https://example.com/hook");
      expect(sub.id).toBeTruthy();
      expect(sub.url).toBe("https://example.com/hook");
      expect(wm.getSubscribers()).toHaveLength(1);
    });

    it("adds subscriber with filters", () => {
      const sub = wm.addSubscriber("https://example.com/hook", {
        sites: ["my-site"],
        events: ["task.completed"],
      });
      expect(sub.filters?.sites).toEqual(["my-site"]);
      expect(sub.filters?.events).toEqual(["task.completed"]);
    });

    it("removes a subscriber", () => {
      const sub = wm.addSubscriber("https://example.com/hook");
      expect(wm.removeSubscriber(sub.id)).toBe(true);
      expect(wm.getSubscribers()).toHaveLength(0);
    });

    it("returns false when removing nonexistent subscriber", () => {
      expect(wm.removeSubscriber("nonexistent")).toBe(false);
    });

    it("gets a subscriber by id", () => {
      const sub = wm.addSubscriber("https://example.com/hook");
      const found = wm.getSubscriber(sub.id);
      expect(found?.url).toBe("https://example.com/hook");
    });

    it("persists subscribers to state file", () => {
      wm.addSubscriber("https://example.com/hook");

      // Create a new manager from the same state file
      const wm2 = new WebhookManager(statePath, logger);
      expect(wm2.getSubscribers()).toHaveLength(1);
      expect(wm2.getSubscribers()[0].url).toBe("https://example.com/hook");
    });
  });

  describe("filter matching", () => {
    const mockRun: TaskRun = {
      id: "run-1",
      site: "my-site",
      task: "my-task",
      status: "completed",
      triggeredBy: "manual",
      attempt: 1,
      startedAt: new Date().toISOString(),
    };

    const mockResult: TaskResult = {
      success: true,
      data: { value: 42 },
      summary: "Test result",
      durationMs: 1000,
      retries: 0,
    };

    it("delivers to subscriber with no filters", async () => {
      wm.addSubscriber("https://httpbin.org/post"); // won't actually deliver in test

      // Mock fetch
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", mockFetch);

      await wm.deliverEvent("task.completed", mockRun, mockResult);

      expect(mockFetch).toHaveBeenCalledTimes(1);

      vi.unstubAllGlobals();
    });

    it("skips subscriber when event filter doesn't match", async () => {
      wm.addSubscriber("https://example.com/hook", {
        events: ["task.failed"],
      });

      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", mockFetch);

      await wm.deliverEvent("task.completed", mockRun, mockResult);

      expect(mockFetch).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    });

    it("skips subscriber when site filter doesn't match", async () => {
      wm.addSubscriber("https://example.com/hook", {
        sites: ["other-site"],
      });

      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", mockFetch);

      await wm.deliverEvent("task.completed", mockRun, mockResult);

      expect(mockFetch).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    });

    it("delivers when filters match", async () => {
      wm.addSubscriber("https://example.com/hook", {
        sites: ["my-site"],
        tasks: ["my-task"],
        events: ["task.completed"],
      });

      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", mockFetch);

      await wm.deliverEvent("task.completed", mockRun, mockResult);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.event).toBe("task.completed");
      expect(body.task.site).toBe("my-site");
      expect(body.result.data.value).toBe(42);

      vi.unstubAllGlobals();
    });
  });

  describe("lastRuns tracking", () => {
    it("updates and retrieves last run timestamps", () => {
      wm.updateLastRun("site/task");
      const runs = wm.getLastRuns();
      expect(runs["site/task"]).toBeTruthy();
    });
  });
});
