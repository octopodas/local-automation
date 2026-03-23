import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type {
  WebhookSubscriber,
  WebhookFilters,
  WebhookPayload,
  WebhookEventType,
  DaemonState,
  DeliveryLogEntry,
  TaskRun,
  TaskResult,
} from "../shared/types.js";
import type { Logger } from "pino";

const MAX_DELIVERY_LOG = 50;
const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_DELIVERY_RETRIES = 3;

export class WebhookManager {
  private statePath: string;
  private state: DaemonState;
  private logger: Logger;

  constructor(statePath: string, logger: Logger) {
    this.statePath = statePath;
    this.logger = logger;
    this.state = this.loadState();
  }

  // --- Subscriber CRUD ---

  addSubscriber(url: string, filters?: WebhookFilters): WebhookSubscriber {
    const subscriber: WebhookSubscriber = {
      id: randomUUID(),
      url,
      filters,
      createdAt: new Date().toISOString(),
    };
    this.state.webhookSubscribers.push(subscriber);
    this.saveState();
    this.logger.info({ subscriberId: subscriber.id, url }, "Webhook subscriber added");
    return subscriber;
  }

  removeSubscriber(id: string): boolean {
    const idx = this.state.webhookSubscribers.findIndex((s) => s.id === id);
    if (idx === -1) return false;
    this.state.webhookSubscribers.splice(idx, 1);
    this.saveState();
    this.logger.info({ subscriberId: id }, "Webhook subscriber removed");
    return true;
  }

  getSubscribers(): WebhookSubscriber[] {
    return [...this.state.webhookSubscribers];
  }

  getSubscriber(id: string): WebhookSubscriber | undefined {
    return this.state.webhookSubscribers.find((s) => s.id === id);
  }

  // --- Delivery ---

  async deliverEvent(
    event: WebhookEventType,
    run: TaskRun,
    result: TaskResult
  ): Promise<void> {
    const payload: WebhookPayload = {
      event,
      timestamp: new Date().toISOString(),
      task: {
        site: run.site,
        name: run.task,
        triggeredBy: run.triggeredBy,
      },
      result,
    };

    const matchingSubscribers = this.state.webhookSubscribers.filter((sub) =>
      this.matchesFilters(sub.filters, event, run.site, run.task)
    );

    if (matchingSubscribers.length === 0) return;

    this.logger.info(
      { event, subscribers: matchingSubscribers.length },
      "Delivering webhook event"
    );

    const deliveries = matchingSubscribers.map((sub) =>
      this.deliverToSubscriber(sub, payload)
    );

    await Promise.allSettled(deliveries);
  }

  private matchesFilters(
    filters: WebhookFilters | undefined,
    event: WebhookEventType,
    site: string,
    task: string
  ): boolean {
    if (!filters) return true;

    if (filters.events && filters.events.length > 0) {
      if (!filters.events.includes(event)) return false;
    }

    if (filters.sites && filters.sites.length > 0) {
      if (!filters.sites.includes(site)) return false;
    }

    if (filters.tasks && filters.tasks.length > 0) {
      if (!filters.tasks.includes(task)) return false;
    }

    return true;
  }

  private async deliverToSubscriber(
    subscriber: WebhookSubscriber,
    payload: WebhookPayload
  ): Promise<void> {
    let lastError: string | undefined;

    for (let attempt = 0; attempt < MAX_DELIVERY_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          DELIVERY_TIMEOUT_MS
        );

        const response = await fetch(subscriber.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        const logEntry: DeliveryLogEntry = {
          timestamp: new Date().toISOString(),
          subscriberId: subscriber.id,
          url: subscriber.url,
          event: payload.event,
          taskKey: `${payload.task.site}/${payload.task.name}`,
          success: response.ok,
          statusCode: response.status,
        };

        this.addDeliveryLog(logEntry);

        if (response.ok) {
          this.logger.info(
            { subscriberId: subscriber.id, status: response.status },
            "Webhook delivered"
          );
          return;
        }

        lastError = `HTTP ${response.status}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }

      // Exponential backoff between retries
      if (attempt < MAX_DELIVERY_RETRIES - 1) {
        const delay = 1000 * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    const logEntry: DeliveryLogEntry = {
      timestamp: new Date().toISOString(),
      subscriberId: subscriber.id,
      url: subscriber.url,
      event: payload.event,
      taskKey: `${payload.task.site}/${payload.task.name}`,
      success: false,
      error: lastError,
    };
    this.addDeliveryLog(logEntry);

    this.logger.error(
      { subscriberId: subscriber.id, error: lastError },
      "Webhook delivery failed after retries"
    );
  }

  // --- State persistence ---

  private loadState(): DaemonState {
    if (existsSync(this.statePath)) {
      try {
        return JSON.parse(readFileSync(this.statePath, "utf-8"));
      } catch (err) {
        this.logger.warn(
          { error: (err as Error).message },
          "Failed to load state, starting fresh"
        );
      }
    }
    return {
      webhookSubscribers: [],
      lastRuns: {},
      deliveryLog: [],
    };
  }

  saveState(): void {
    try {
      const dir = dirname(this.statePath);
      mkdirSync(dir, { recursive: true });

      const tmpPath = this.statePath + ".tmp";
      writeFileSync(tmpPath, JSON.stringify(this.state, null, 2));
      renameSync(tmpPath, this.statePath);
    } catch (err) {
      this.logger.error(
        { error: (err as Error).message },
        "Failed to save state"
      );
    }
  }

  updateLastRun(taskKey: string): void {
    this.state.lastRuns[taskKey] = new Date().toISOString();
    this.saveState();
  }

  getLastRuns(): Record<string, string> {
    return { ...this.state.lastRuns };
  }

  private addDeliveryLog(entry: DeliveryLogEntry): void {
    this.state.deliveryLog.push(entry);
    if (this.state.deliveryLog.length > MAX_DELIVERY_LOG) {
      this.state.deliveryLog = this.state.deliveryLog.slice(-MAX_DELIVERY_LOG);
    }
    this.saveState();
  }

  getDeliveryLog(): DeliveryLogEntry[] {
    return [...this.state.deliveryLog];
  }
}
