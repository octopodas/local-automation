import OpenAI from "openai";
import type { Logger } from "pino";
import type { TaskContext } from "../shared/types.js";
import type { AIProvider, AIResponse } from "./provider.js";
import {
  buildSystemPrompt,
  buildUserMessage,
  parseAIResponse,
} from "./provider.js";

const MAX_PARSE_RETRIES = 3;

function safeFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message === "No text response from OpenAI") {
    return error.message;
  }

  return "OpenAI request or response failed";
}

export class OpenAIProvider implements AIProvider {
  private client: OpenAI;
  private model: string;
  private logger: Logger;

  constructor(model: string, logger: Logger) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY environment variable is not set");
    }

    this.client = new OpenAI({
      apiKey,
      baseURL: "https://api.openai.com/v1",
      logLevel: "off",
      maxRetries: 0,
    });
    this.model = model;
    this.logger = logger;
  }

  async analyzeScreenshot(
    screenshot: Buffer,
    dom: string,
    context: TaskContext
  ): Promise<AIResponse> {
    const imageUrl = `data:image/png;base64,${screenshot.toString("base64")}`;
    const userMessage = buildUserMessage(dom, context);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_PARSE_RETRIES; attempt++) {
      try {
        const response = await this.client.responses.create({
          model: this.model,
          store: false,
          max_output_tokens: 4096,
          instructions: buildSystemPrompt(),
          input: [
            {
              role: "user",
              content: [
                { type: "input_image", image_url: imageUrl, detail: "auto" },
                { type: "input_text", text: userMessage },
              ],
            },
          ],
        });

        if (!response.output_text) {
          throw new Error("No text response from OpenAI");
        }

        return { action: parseAIResponse(response.output_text) };
      } catch (err) {
        lastError = new Error(safeFailureMessage(err));
        this.logger.warn(
          { attempt: attempt + 1, error: lastError.message },
          "OpenAI response failed, retrying"
        );
      }
    }

    throw new Error(
      `Failed to get valid AI action after ${MAX_PARSE_RETRIES} attempts: ${lastError?.message}`
    );
  }
}
