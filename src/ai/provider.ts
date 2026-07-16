import type { AIAction, TaskContext } from "../shared/types.js";
import { aiActionSchema } from "../config/schema.js";
import type { Logger } from "pino";

export interface AIResponse {
  action: AIAction;
  thinking?: string;
}

export interface AIProvider {
  analyzeScreenshot(
    screenshot: Buffer,
    dom: string,
    context: TaskContext
  ): Promise<AIResponse>;
}

/**
 * Parse and validate an AI response string into an AIAction.
 * Retries extraction up to maxRetries times if JSON is malformed.
 */
export function parseAIResponse(raw: string): AIAction {
  // Try to extract JSON from the response (AI may wrap it in markdown code blocks,
  // and some models — like MiniMax M3 — emit a <think>...</think> reasoning block
  // *before* the JSON. Strip those out first, otherwise JSON.parse throws on the
  // "<think>" prefix and the whole task fails.)
  let jsonStr = raw.trim();

  // 1. Strip <think>...</think> reasoning blocks (MiniMax, DeepSeek R1, etc.)
  jsonStr = jsonStr.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  // 2. If the response still has a stray leading <think> with no closing tag
  //    (truncated output), cut everything up to the first '{' or '['.
  if (/^<think>/i.test(jsonStr)) {
    jsonStr = jsonStr.replace(/^<think>[\s\S]*/i, (m) => {
      const firstBrace = m.search(/[{[]/);
      return firstBrace >= 0 ? m.slice(firstBrace) : "";
    });
  }

  // 3. Strip markdown code fences if present
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

CRITICAL: You MUST respond with ONLY a single JSON object. No text before or after. No explanation. No markdown. Just raw JSON matching one of these action types:

{"action":"click","selector":"<css-selector>"}
{"action":"type","selector":"<css-selector>","text":"<text-to-type>"}
{"action":"select","selector":"<css-selector>","value":"<option-value>"}
{"action":"navigate","url":"<url>"}
{"action":"scroll","direction":"up|down|left|right","amount":<pixels>}
{"action":"wait","ms":<milliseconds>}
{"action":"extract","selector":"<css-selector>","format":"text|html|table"}
{"action":"download","selector":"<css-selector>"}
{"action":"done","result":{<extracted-data>},"summary":"<human-readable-summary>"}

Guidelines:
- Use CSS selectors from the DOM snapshot for reliable element targeting
- For targeting elements by text, use Playwright's CSS extension \`:has-text("text")\` (e.g., \`button:has-text("Submit")\`) or Playwright's text selector engine (e.g., \`text="Submit"\`). Do NOT use jQuery's \`:contains()\` pseudo-class as it is not valid CSS or standard Playwright.
- Use "extract" to pull data from the page, then "done" when you have all requested data
- Use "download" to click a link/button that triggers a file download — the file is saved automatically
- If login is required, use the provided credentials — type the username, then password, then click submit
- If an action fails, you'll see the error — try an alternative approach
- When you have all the requested data, use "done" to finish
- CRITICAL: The "done" result must contain actual data values read from the page, NEVER CSS selectors, JavaScript expressions, template strings like {{...}}, or document.querySelector(...) calls. Use "extract" to read real values from the page first, then put the actual text/numbers in the "done" result.

REMEMBER: Output ONLY valid JSON. No explanations, no thinking, no text. Just one JSON object.`;
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
      `Login required. Use these credentials:\n` +
        `  Username field: "${context.loginHints.usernameField}" → type "${context.loginHints.credentials.username}"\n` +
        `  Password field: "${context.loginHints.passwordField}" → type "${context.loginHints.credentials.password}"\n` +
        `  Submit button: "${context.loginHints.submitButton}"`
    );
  }

  if (context.error) {
    parts.push(`Previous action error: ${context.error}`);
  }

  if (context.actionHistory.length > 0) {
    const history = context.actionHistory
      .map((h, i) => {
        let status = h.success ? "OK" : `FAILED: ${h.error}`;
        if (h.success && h.data) {
          status += ` — ${JSON.stringify(h.data)}`;
        }
        return `  ${i + 1}. ${JSON.stringify(h.action)} → ${status}`;
      })
      .join("\n");
    parts.push(`Action history:\n${history}`);
  }

  parts.push(`\nDOM snapshot (simplified):\n${dom.slice(0, 50000)}`);

  return parts.join("\n\n");
}

export async function createAIProvider(
  provider: "anthropic" | "gemini" | "opencode",
  model: string,
  logger: Logger
): Promise<AIProvider> {
  // Dynamic import to avoid loading every SDK up front
  if (provider === "anthropic") {
    const { AnthropicProvider } = await import("./anthropic.js");
    return new AnthropicProvider(model, logger);
  } else if (provider === "gemini") {
    const { GeminiProvider } = await import("./gemini.js");
    return new GeminiProvider(model, logger);
  } else {
    const { OpenCodeProvider } = await import("./opencode.js");
    return new OpenCodeProvider(model, logger);
  }
}
