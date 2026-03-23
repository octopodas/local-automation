import { runBrowserAgent } from "./browser-agent.js";
import { createAIProvider } from "../ai/provider.js";
import { createLogger } from "../shared/logger.js";
import type { DaemonMessage, WorkerMessage } from "../shared/types.js";

const logger = createLogger({ name: "worker" });

function send(msg: WorkerMessage): void {
  if (process.send) {
    process.send(msg);
  }
}

process.on("message", async (msg: DaemonMessage) => {
  if (msg.type === "cancel") {
    logger.info("Received cancel signal, exiting");
    process.exit(0);
  }

  if (msg.type === "execute") {
    const { taskConfig, siteConfig, aiConfig } = msg;

    logger.info(
      { site: siteConfig.name, task: taskConfig.name },
      "Starting task execution"
    );

    try {
      const aiProvider = await createAIProvider(aiConfig.provider, aiConfig.model, logger);

      const result = await runBrowserAgent({
        siteConfig,
        taskConfig,
        aiConfig,
        aiProvider,
        logger,
        onProgress: (iteration, action) => {
          send({
            type: "progress",
            iteration,
            action,
          });
        },
      });

      send({
        type: "result",
        success: true,
        data: result.data,
        summary: result.summary,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isRetryable =
        message.includes("timeout") ||
        message.includes("net::") ||
        message.includes("ECONNREFUSED") ||
        message.includes("Max iterations") ||
        message.includes("rate") ||
        message.includes("503") ||
        message.includes("529");

      logger.error({ error: message }, "Task execution failed");

      send({
        type: "error",
        message,
        code: "TASK_EXECUTION_ERROR",
        retryable: isRetryable,
      });
    }

    // Exit after task completes (one task per worker)
    process.exit(0);
  }
});

// Handle uncaught errors
process.on("uncaughtException", (err) => {
  logger.fatal({ error: err.message }, "Uncaught exception in worker");
  send({
    type: "error",
    message: err.message,
    code: "UNCAUGHT_EXCEPTION",
    retryable: true,
  });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  logger.fatal({ error: message }, "Unhandled rejection in worker");
  send({
    type: "error",
    message,
    code: "UNHANDLED_REJECTION",
    retryable: true,
  });
  process.exit(1);
});
