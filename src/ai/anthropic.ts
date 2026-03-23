import Anthropic from "@anthropic-ai/sdk";
import type { AIProvider } from "./provider.js";
import { parseAIResponse, buildSystemPrompt, buildUserMessage } from "./provider.js";
import type { AIAction, TaskContext } from "../shared/types.js";
import type { Logger } from "pino";

const MAX_PARSE_RETRIES = 3;

export class AnthropicProvider implements AIProvider {
  private client: Anthropic;
  private model: string;
  private logger: Logger;

  constructor(model: string, logger: Logger) {
    this.client = new Anthropic();
    this.model = model;
    this.logger = logger;
  }

  async analyzeScreenshot(
    screenshot: Buffer,
    dom: string,
    context: TaskContext
  ): Promise<AIAction> {
    const systemPrompt = buildSystemPrompt();
    const userMessage = buildUserMessage(dom, context);
    const screenshotBase64 = screenshot.toString("base64");

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_PARSE_RETRIES; attempt++) {
      try {
        const response = await this.client.messages.create({
          model: this.model,
          max_tokens: 1024,
          system: systemPrompt,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: screenshotBase64,
                  },
                },
                {
                  type: "text",
                  text: userMessage,
                },
              ],
            },
          ],
        });

        const textBlock = response.content.find((b) => b.type === "text");
        if (!textBlock || textBlock.type !== "text") {
          throw new Error("No text response from Anthropic");
        }

        return parseAIResponse(textBlock.text);
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
