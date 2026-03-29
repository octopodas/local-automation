import Anthropic from "@anthropic-ai/sdk";
import type { AIProvider, AIResponse } from "./provider.js";
import { parseAIResponse, buildSystemPrompt, buildUserMessage } from "./provider.js";
import type { TaskContext } from "../shared/types.js";
import type { Logger } from "pino";

const MAX_PARSE_RETRIES = 3;

export class AnthropicProvider implements AIProvider {
  private client: Anthropic;
  private model: string;
  private logger: Logger;
  private thinkingEnabled: boolean;

  constructor(model: string, logger: Logger) {
    this.client = new Anthropic();
    this.model = model;
    this.logger = logger;
    this.thinkingEnabled = true;
  }

  async analyzeScreenshot(
    screenshot: Buffer,
    dom: string,
    context: TaskContext
  ): Promise<AIResponse> {
    const systemPrompt = buildSystemPrompt();
    const userMessage = buildUserMessage(dom, context);
    const screenshotBase64 = screenshot.toString("base64");

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_PARSE_RETRIES; attempt++) {
      try {
        const response = await this.client.messages.create(
          this.thinkingEnabled
            ? {
                model: this.model,
                max_tokens: 16000,
                thinking: {
                  type: "enabled",
                  budget_tokens: 10000,
                },
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
              }
            : {
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
              }
        );

        // Extract thinking content if present
        const contentTypes = response.content.map((b) => b.type);
        const thinkingBlock = response.content.find(
          (b) => b.type === "thinking"
        );
        const thinking =
          thinkingBlock && thinkingBlock.type === "thinking"
            ? thinkingBlock.thinking
            : undefined;

        this.logger.info(
          {
            thinkingRequested: this.thinkingEnabled,
            thinkingReceived: !!thinking,
            contentTypes,
          },
          "AI response received"
        );

        const textBlock = response.content.find((b) => b.type === "text");
        if (!textBlock || textBlock.type !== "text") {
          throw new Error("No text response from Anthropic");
        }

        return { action: parseAIResponse(textBlock.text), thinking };
      } catch (err) {
        lastError = err as Error;

        // If thinking is not supported by this model, disable and retry immediately.
        // Only match Anthropic API errors (BadRequestError), not parse failures.
        if (
          this.thinkingEnabled &&
          err instanceof Anthropic.BadRequestError &&
          lastError.message.includes("thinking")
        ) {
          this.logger.warn(
            { model: this.model },
            "Extended thinking not supported by this model, disabling"
          );
          this.thinkingEnabled = false;
          attempt--; // don't count this as a parse retry
          continue;
        }

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
