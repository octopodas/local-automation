import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, symlinkSync, unlinkSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type {
  TaskConfig,
  SiteConfig,
  AIConfig,
  TaskRun,
  TaskResult,
  WorkerMessage,
  DaemonMessage,
} from "../shared/types.js";
import type { Logger } from "pino";
import { EventEmitter } from "node:events";

const WATCHDOG_TIMEOUT_MS = 120_000; // 2 minutes
const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = resolve(__dirname, "../worker/index.js");

interface RunningTask {
  run: TaskRun;
  worker: ChildProcess;
  watchdogTimer: ReturnType<typeof setTimeout>;
  lastMessageAt: number;
  resolve: (result: TaskResult) => void;
  reject: (error: Error) => void;
}

export class TaskManager extends EventEmitter {
  private runningTasks = new Map<string, RunningTask>();
  private taskQueue: Array<{
    run: TaskRun;
    siteConfig: SiteConfig;
    taskConfig: TaskConfig;
    aiConfig: AIConfig;
    resolve: (result: TaskResult) => void;
    reject: (error: Error) => void;
  }> = [];
  private maxConcurrent: number;
  private aiConfig: AIConfig;
  private logger: Logger;
  private resultsDir: string;
  private taskRuns = new Map<string, TaskRun>();

  constructor(opts: {
    maxConcurrent: number;
    aiConfig: AIConfig;
    logger: Logger;
    resultsDir: string;
  }) {
    super();
    this.maxConcurrent = opts.maxConcurrent;
    this.aiConfig = opts.aiConfig;
    this.logger = opts.logger;
    this.resultsDir = opts.resultsDir;
  }

  /**
   * Run a task. Returns a promise that resolves with the task result.
   * If the task is already running, it's queued.
   */
  async runTask(
    siteConfig: SiteConfig,
    taskConfig: TaskConfig,
    triggeredBy: "schedule" | "manual"
  ): Promise<TaskResult> {
    const taskKey = `${siteConfig.name}/${taskConfig.name}`;

    // Check if same task is already running — queue it
    const isRunning = Array.from(this.runningTasks.values()).some(
      (rt) => rt.run.site === siteConfig.name && rt.run.task === taskConfig.name
    );

    const run: TaskRun = {
      id: randomUUID(),
      site: siteConfig.name,
      task: taskConfig.name,
      status: isRunning || this.runningTasks.size >= this.maxConcurrent ? "pending" : "running",
      triggeredBy,
      attempt: 1,
      startedAt: new Date().toISOString(),
    };

    this.taskRuns.set(run.id, run);

    return new Promise<TaskResult>((resolve, reject) => {
      if (run.status === "pending") {
        this.logger.info({ taskKey, taskId: run.id }, "Task queued");
        this.taskQueue.push({
          run,
          siteConfig,
          taskConfig,
          aiConfig: this.aiConfig,
          resolve,
          reject,
        });
        return;
      }

      this.spawnWorker(run, siteConfig, taskConfig, resolve, reject);
    });
  }

  getTaskRun(taskId: string): TaskRun | undefined {
    return this.taskRuns.get(taskId);
  }

  getRunningTasks(): TaskRun[] {
    return Array.from(this.runningTasks.values()).map((rt) => rt.run);
  }

  getAllTasks(): TaskRun[] {
    return Array.from(this.taskRuns.values());
  }

  private spawnWorker(
    run: TaskRun,
    siteConfig: SiteConfig,
    taskConfig: TaskConfig,
    resolve: (result: TaskResult) => void,
    reject: (error: Error) => void
  ): void {
    const taskKey = `${siteConfig.name}/${taskConfig.name}`;
    this.logger.info(
      { taskKey, taskId: run.id, attempt: run.attempt },
      "Spawning worker"
    );

    run.status = "running";
    run.startedAt = new Date().toISOString();

    const worker = fork(WORKER_PATH, [], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });

    const startTime = Date.now();

    const watchdogTimer = this.createWatchdog(run.id);

    const runningTask: RunningTask = {
      run,
      worker,
      watchdogTimer,
      lastMessageAt: Date.now(),
      resolve,
      reject,
    };

    this.runningTasks.set(run.id, runningTask);

    // Send execute message
    const message: DaemonMessage = {
      type: "execute",
      taskConfig,
      siteConfig,
      aiConfig: this.aiConfig,
    };
    worker.send(message);

    worker.on("message", (msg: WorkerMessage) => {
      runningTask.lastMessageAt = Date.now();
      this.resetWatchdog(run.id);

      switch (msg.type) {
        case "progress":
          this.logger.info(
            { taskKey, iteration: msg.iteration, action: msg.action },
            "Task progress"
          );
          this.emit("progress", run.id, msg);
          break;

        case "result":
          const result: TaskResult = {
            success: true,
            data: msg.data,
            summary: msg.summary,
            durationMs: Date.now() - startTime,
            retries: run.attempt - 1,
          };
          run.status = "completed";
          run.completedAt = new Date().toISOString();
          run.result = result;
          this.cleanup(run.id);
          this.writeResult(siteConfig.name, taskConfig.name, result);
          this.emit("taskCompleted", run, result);
          resolve(result);
          this.processQueue();
          break;

        case "error":
          this.handleWorkerError(
            run,
            siteConfig,
            taskConfig,
            msg,
            startTime,
            resolve,
            reject
          );
          break;
      }
    });

    worker.on("exit", (code) => {
      if (this.runningTasks.has(run.id)) {
        // Worker exited unexpectedly
        this.handleWorkerError(
          run,
          siteConfig,
          taskConfig,
          {
            type: "error",
            message: `Worker exited with code ${code}`,
            code: "WORKER_CRASH",
            retryable: true,
          },
          startTime,
          resolve,
          reject
        );
      }
    });

    worker.on("error", (err) => {
      if (this.runningTasks.has(run.id)) {
        this.handleWorkerError(
          run,
          siteConfig,
          taskConfig,
          {
            type: "error",
            message: err.message,
            code: "WORKER_ERROR",
            retryable: true,
          },
          startTime,
          resolve,
          reject
        );
      }
    });
  }

  private handleWorkerError(
    run: TaskRun,
    siteConfig: SiteConfig,
    taskConfig: TaskConfig,
    msg: WorkerMessage & { type: "error" },
    startTime: number,
    resolve: (result: TaskResult) => void,
    reject: (error: Error) => void
  ): void {
    const taskKey = `${siteConfig.name}/${taskConfig.name}`;
    this.cleanup(run.id);

    const maxAttempts = taskConfig.retry.maxAttempts;
    const canRetry = msg.retryable && run.attempt < maxAttempts;

    if (canRetry) {
      const backoffMs =
        taskConfig.retry.backoffMs * Math.pow(2, run.attempt - 1);
      this.logger.warn(
        { taskKey, attempt: run.attempt, maxAttempts, backoffMs, error: msg.message },
        "Task failed, retrying"
      );

      run.status = "retrying";
      run.attempt += 1;

      setTimeout(() => {
        this.spawnWorker(run, siteConfig, taskConfig, resolve, reject);
      }, backoffMs);
    } else {
      const result: TaskResult = {
        success: false,
        data: {},
        summary: msg.message,
        durationMs: Date.now() - startTime,
        retries: run.attempt - 1,
      };
      run.status = "failed";
      run.completedAt = new Date().toISOString();
      run.error = msg.message;
      run.result = result;

      this.logger.error(
        { taskKey, attempt: run.attempt, error: msg.message },
        "Task failed permanently"
      );
      this.emit("taskFailed", run, result);
      reject(new Error(msg.message));
      this.processQueue();
    }
  }

  private createWatchdog(taskId: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const task = this.runningTasks.get(taskId);
      if (task) {
        this.logger.error(
          { taskId, lastMessageAt: task.lastMessageAt },
          "Watchdog timeout — killing worker"
        );
        task.worker.kill("SIGKILL");
      }
    }, WATCHDOG_TIMEOUT_MS);
  }

  private resetWatchdog(taskId: string): void {
    const task = this.runningTasks.get(taskId);
    if (task) {
      clearTimeout(task.watchdogTimer);
      task.watchdogTimer = this.createWatchdog(taskId);
    }
  }

  private cleanup(taskId: string): void {
    const task = this.runningTasks.get(taskId);
    if (task) {
      clearTimeout(task.watchdogTimer);
      if (task.worker.connected) {
        task.worker.kill();
      }
      this.runningTasks.delete(taskId);
    }
  }

  private processQueue(): void {
    while (
      this.taskQueue.length > 0 &&
      this.runningTasks.size < this.maxConcurrent
    ) {
      const queued = this.taskQueue.shift()!;
      this.spawnWorker(
        queued.run,
        queued.siteConfig,
        queued.taskConfig,
        queued.resolve,
        queued.reject
      );
    }
  }

  private writeResult(
    siteName: string,
    taskName: string,
    result: TaskResult
  ): void {
    try {
      const dir = resolve(this.resultsDir, siteName, taskName);
      mkdirSync(dir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filePath = resolve(dir, `${timestamp}.json`);
      writeFileSync(filePath, JSON.stringify(result, null, 2));

      // Update latest symlink
      const latestPath = resolve(dir, "latest.json");
      try {
        unlinkSync(latestPath);
      } catch {
        // OK if it doesn't exist
      }
      symlinkSync(filePath, latestPath);

      this.logger.info({ filePath }, "Result written to file");
    } catch (err) {
      this.logger.error(
        { error: (err as Error).message },
        "Failed to write result file"
      );
    }
  }

  /**
   * Graceful shutdown — wait for workers to finish or kill after timeout.
   */
  async shutdown(timeoutMs = 30_000): Promise<void> {
    this.logger.info("Shutting down task manager");
    this.taskQueue.length = 0; // Clear queue

    if (this.runningTasks.size === 0) return;

    const deadline = Date.now() + timeoutMs;

    // Wait for running tasks to complete
    await new Promise<void>((resolve) => {
      const check = () => {
        if (this.runningTasks.size === 0 || Date.now() > deadline) {
          resolve();
        } else {
          setTimeout(check, 500);
        }
      };
      check();
    });

    // Force-kill remaining workers
    for (const [id, task] of this.runningTasks) {
      this.logger.warn({ taskId: id }, "Force-killing worker on shutdown");
      task.worker.kill("SIGKILL");
      clearTimeout(task.watchdogTimer);
    }
    this.runningTasks.clear();
  }
}
