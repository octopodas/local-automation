import type { AIAction, TaskContext } from "../shared/types.js";
import { aiActionSchema } from "../config/schema.js";
import type { Logger } from "pino";

export interface AIProvider {
  analyzeScreenshot(
    screenshot: Buffer,
    dom: string,
    context: TaskContext
  ): Promise<AIAction>;
}

/**
 * Parse and validate an AI response string into an AIAction.
 * Retries extraction up to maxRetries times if JSON is malformed.
 */
export function parseAIResponse(raw: string): AIAction {
  // Try to extract JSON from the response (AI may wrap it in markdown code blocks)
  let jsonStr = raw.trim();

  // Strip markdown code fences if present
  const jsonMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`Failed to parse AI response as JSON: ${jsonStr.slice(0, 200)}`);
  }

  const result = aiActionSchema.safeParse(parsed);
  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid AI action: ${errors}`);
  }

  return result.data as AIAction;
}

/**
 * Build the system prompt for the browser agent.
 */
export function buildSystemPrompt(): string {
  return `You are a browser automation agent. You navigate web pages and extract data.

You receive a screenshot and DOM snapshot of the current page. Based on the task prompt, decide what action to take next.

Respond with a single JSON object (no markdown, no explanation) matching one of these action types:

{"action":"click","selector":"<css-selector>"}
{"action":"type","selector":"<css-selector>","text":"<text-to-type>"}
{"action":"select","selector":"<css-selector>","value":"<option-value>"}
{"action":"navigate","url":"<url>"}
{"action":"scroll","direction":"up|down|left|right","amount":<pixels>}
{"action":"wait","ms":<milliseconds>}
{"action":"extract","selector":"<css-selector>","format":"text|html|table"}
{"action":"done","result":{<extracted-data>},"summary":"<human-readable-summary>"}

Guidelines:
- Use CSS selectors from the DOM snapshot for reliable element targeting
- Use "extract" to pull data from the page, then "done" when you have all requested data
- If login is required, use the provided login hints to fill credentials
- If an action fails, you'll see the error — try an alternative approach
- When you have all the requested data, use "done" to finish`;
}

/**
 * Build the user message content describing the current page state and task.
 */
export function buildUserMessage(dom: string, context: TaskContext): string {
  const parts: string[] = [];

  parts.push(`Task: ${context.prompt}`);
  parts.push(`Site: ${context.siteConfig.name} (${context.siteConfig.url})`);
  parts.push(`Iteration: ${context.iteration}/${context.maxIterations}`);

  if (context.loginHints) {
    parts.push(
      `Login hints: username field="${context.loginHints.usernameField}", ` +
        `password field="${context.loginHints.passwordField}", ` +
        `submit button="${context.loginHints.submitButton}"`
    );
  }

  if (context.error) {
    parts.push(`Previous action error: ${context.error}`);
  }

  if (context.actionHistory.length > 0) {
    const history = context.actionHistory
      .map((h, i) => {
        const status = h.success ? "OK" : `FAILED: ${h.error}`;
        return `  ${i + 1}. ${JSON.stringify(h.action)} → ${status}`;
      })
      .join("\n");
    parts.push(`Action history:\n${history}`);
  }

  parts.push(`\nDOM snapshot (simplified):\n${dom.slice(0, 50000)}`);

  return parts.join("\n\n");
}

export async function createAIProvider(
  provider: "anthropic" | "gemini",
  model: string,
  logger: Logger
): Promise<AIProvider> {
  // Dynamic import to avoid loading both SDKs
  if (provider === "anthropic") {
    const { AnthropicProvider } = await import("./anthropic.js");
    return new AnthropicProvider(model, logger);
  } else {
    const { GeminiProvider } = await import("./gemini.js");
    return new GeminiProvider(model, logger);
  }
}
