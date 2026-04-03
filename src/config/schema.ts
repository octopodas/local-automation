import { z } from "zod";

export const retrySchema = z.object({
  maxAttempts: z.number().int().min(1).default(3),
  backoffMs: z.number().int().min(0).default(5000),
});

export const taskOutputSchema = z.object({
  webhooks: z.boolean().default(false),
});

export const taskSchema = z.object({
  name: z.string().min(1),
  schedule: z.string().optional(),
  prompt: z.string().min(1),
  output: taskOutputSchema.default({}),
  retry: retrySchema.default({}),
});

export const loginSchema = z.object({
  type: z.literal("form"),
  usernameField: z.string().min(1),
  passwordField: z.string().min(1),
  submitButton: z.string().min(1),
  credentials: z.object({
    username: z.string().min(1),
    password: z.string().min(1),
  }),
});

export const siteSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  login: loginSchema.optional(),
  tasks: z.array(taskSchema).min(1),
});

export const daemonSchema = z.object({
  port: z.number().int().min(1).max(65535).default(3847),
  host: z.string().default("127.0.0.1"),
  maxConcurrentWorkers: z.number().int().min(1).default(2),
});

export const aiSchema = z.object({
  provider: z.enum(["anthropic", "gemini"]),
  model: z.string().min(1),
  maxIterations: z.number().int().min(1).default(20),
});

export const telegramSchema = z.object({
  botToken: z.string().min(1),
  chatId: z.string().min(1),
});

export const notificationsSchema = z.object({
  telegram: telegramSchema.optional(),
});

export const appConfigSchema = z.object({
  daemon: daemonSchema.default({}),
  ai: aiSchema,
  sites: z.array(siteSchema).min(1),
  notifications: notificationsSchema.optional(),
});

// Zod schema for AI actions (used to validate AI responses)
export const aiActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("click"), selector: z.string() }),
  z.object({ action: z.literal("type"), selector: z.string(), text: z.string() }),
  z.object({ action: z.literal("select"), selector: z.string(), value: z.string() }),
  z.object({ action: z.literal("navigate"), url: z.string() }),
  z.object({
    action: z.literal("scroll"),
    direction: z.enum(["up", "down", "left", "right"]),
    amount: z.number().optional(),
  }),
  z.object({ action: z.literal("wait"), ms: z.number() }),
  z.object({
    action: z.literal("extract"),
    selector: z.string(),
    format: z.enum(["text", "html", "table"]),
  }),
  z.object({ action: z.literal("download"), selector: z.string() }),
  z.object({
    action: z.literal("done"),
    result: z.record(z.unknown()),
    summary: z.string(),
  }),
]);
