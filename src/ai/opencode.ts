import type { AIProvider, AIResponse } from "./provider.js";
import { parseAIResponse, buildSystemPrompt, buildUserMessage } from "./provider.js";
import type { TaskContext } from "../shared/types.js";
import type { Logger } from "pino";

const MAX_PARSE_RETRIES = 3;
const OPENCODE_ZEN_URL = "https://opencode.ai/zen/v1/chat/completions";

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string;
    };
  }>;
  error?: { message?: string; type?: string };
}

/**
 * Provider for OpenCode Zen — a gateway offering a curated set of models
 * through an OpenAI-compatible /chat/completions endpoint.
 *
 * Use any vision-capable model available in your Zen subscription
 * (e.g. "glm-4.5v", "minimax-m2.5"). Non-vision models will fail because
 * this agent sends a screenshot on every turn.
 *
 * Auth: set OPEN_CODE_ZEN_KEY in your environment.
 * Docs: https://opencode.ai/docs/zen/
 */
export class OpenCodeProvider implements AIProvider {
  private apiKey: string;
  private model: string;
  private logger: Logger;

  constructor(model: string, logger: Logger) {
    const apiKey = process.env.OPEN_CODE_ZEN_KEY;
    if (!apiKey) {
      throw new Error("OPEN_CODE_ZEN_KEY environment variable is not set");
    }
    this.apiKey = apiKey;
    this.model = model;
    this.logger = logger;
  }

  async analyzeScreenshot(
    screenshot: Buffer,
    dom: string,
    context: TaskContext
  ): Promise<AIResponse> {
    const systemPrompt = buildSystemPrompt();
    const userMessage = buildUserMessage(dom, context);
    const screenshotBase64 = screenshot.toString("base64");
    const imageDataUrl = `data:image/png;base64,${screenshotBase64}`;

    const body = {
      model: this.model,
      max_tokens: 4096,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: imageDataUrl } },
            { type: "text", text: userMessage },
          ],
        },
      ],
    };

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_PARSE_RETRIES; attempt++) {
      try {
        const res = await fetch(OPENCODE_ZEN_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(
            `OpenCode Zen API error ${res.status} ${res.statusText}: ${errText.slice(0, 500)}`
          );
        }

        const data = (await res.json()) as ChatCompletionResponse;

        if (data.error) {
          throw new Error(`OpenCode Zen error: ${data.error.message ?? "unknown"}`);
        }

        const text = data.choices?.[0]?.message?.content;
        if (!text) {
          throw new Error("No text response from OpenCode Zen");
        }

        return { action: parseAIResponse(text) };
      } catch (err) {
        lastError = err as Error;
        this.logger.warn(
          { attempt: attempt + 1, error: lastError.message },
          "AI response parse failed, retrying"
        );
      }
    }

    throw new Error(
      `Failed to get valid AI action after ${MAX_PARSE_RETRIES} attempts: ${lastError?.message}`
    );
  }
}
