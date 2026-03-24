// --- AI Actions ---

export type AIAction =
  | { action: "click"; selector: string }
  | { action: "type"; selector: string; text: string }
  | { action: "select"; selector: string; value: string }
  | { action: "navigate"; url: string }
  | { action: "scroll"; direction: "up" | "down" | "left" | "right"; amount?: number }
  | { action: "wait"; ms: number }
  | { action: "extract"; selector: string; format: "text" | "html" | "table" }
  | { action: "done"; result: Record<string, unknown>; summary: string };

// --- Task Context (sent to AI on each iteration) ---

export interface TaskContext {
  siteConfig: SiteConfig;
  taskConfig: TaskConfig;
  prompt: string;
  actionHistory: ActionHistoryEntry[];
  iteration: number;
  maxIterations: number;
  loginHints?: LoginConfig;
  error?: string; // error from previous action
}

export interface ActionHistoryEntry {
  action: AIAction;
  success: boolean;
  error?: string;
}

// --- Config types ---

export interface AppConfig {
  daemon: DaemonConfig;
  ai: AIConfig;
  sites: SiteConfig[];
  notifications?: NotificationsConfig;
}

export interface NotificationsConfig {
  telegram?: TelegramConfig;
}

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export interface DaemonConfig {
  port: number;
  host: string;
  maxConcurrentWorkers: number;
}

export interface AIConfig {
  provider: "anthropic" | "gemini";
  model: string;
  maxIterations: number;
}

export interface SiteConfig {
  name: string;
  url: string;
  login?: LoginConfig;
  tasks: TaskConfig[];
}

export interface LoginConfig {
  type: "form";
  usernameField: string;
  passwordField: string;
  submitButton: string;
  credentials: {
    username: string;
    password: string;
  };
}

export interface TaskConfig {
  name: string;
  schedule?: string;
  prompt: string;
  output: TaskOutputConfig;
  retry: RetryConfig;
}

export interface TaskOutputConfig {
  webhooks: boolean;
}

export interface RetryConfig {
  maxAttempts: number;
  backoffMs: number;
}

// --- Worker IPC Messages ---

export type WorkerMessage =
  | { type: "progress"; iteration: number; action: string; screenshot?: string }
  | { type: "result"; success: true; data: Record<string, unknown>; summary: string }
  | { type: "error"; message: string; code: string; retryable: boolean };

export type DaemonMessage =
  | { type: "execute"; taskConfig: TaskConfig; siteConfig: SiteConfig; aiConfig: AIConfig }
  | { type: "cancel" };

// --- Task execution state ---

export interface TaskRun {
  id: string;
  site: string;
  task: string;
  status: "pending" | "running" | "completed" | "failed" | "retrying";
  triggeredBy: "schedule" | "manual";
  attempt: number;
  startedAt: string;
  completedAt?: string;
  result?: TaskResult;
  error?: string;
}

export interface TaskResult {
  success: boolean;
  data: Record<string, unknown>;
  summary: string;
  durationMs: number;
  retries: number;
}

// --- Webhook types ---

export interface WebhookSubscriber {
  id: string;
  url: string;
  filters?: WebhookFilters;
  createdAt: string;
}

export interface WebhookFilters {
  sites?: string[];
  tasks?: string[];
  events?: WebhookEventType[];
}

export type WebhookEventType = "task.completed" | "task.failed";

export interface WebhookPayload {
  event: WebhookEventType;
  timestamp: string;
  task: {
    site: string;
    name: string;
    triggeredBy: "schedule" | "manual";
  };
  result: TaskResult;
}

// --- Daemon state (persisted in state.json) ---

export interface DaemonState {
  webhookSubscribers: WebhookSubscriber[];
  lastRuns: Record<string, string>; // taskKey -> ISO timestamp
  deliveryLog: DeliveryLogEntry[];
}

export interface DeliveryLogEntry {
  timestamp: string;
  subscriberId: string;
  url: string;
  event: WebhookEventType;
  taskKey: string;
  success: boolean;
  statusCode?: number;
  error?: string;
}
