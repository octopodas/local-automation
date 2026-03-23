import { GoogleGenerativeAI } from "@google/generative-ai";
import type { AIProvider } from "./provider.js";
import { parseAIResponse, buildSystemPrompt, buildUserMessage } from "./provider.js";
import type { AIAction, TaskContext } from "../shared/types.js";
import type { Logger } from "pino";

const MAX_PARSE_RETRIES = 3;

export class GeminiProvider implements AIProvider {
  private genAI: GoogleGenerativeAI;
  private model: string;
  private logger: Logger;

  constructor(model: string, logger: Logger) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is not set");
    }
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = model;
    this.logger = logger;
  }

  async analyzeScreenshot(
    screenshot: Buffer,
    dom: string,
    context: TaskContext
  ): Promise<AIAction> {
    const model = this.genAI.getGenerativeModel({
      model: this.model,
      systemInstruction: buildSystemPrompt(),
    });

    const userMessage = buildUserMessage(dom, context);
    const screenshotBase64 = screenshot.toString("base64");

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_PARSE_RETRIES; attempt++) {
      try {
        const result = await model.generateContent([
          {
            inlineData: {
              mimeType: "image/png",
              data: screenshotBase64,
            },
          },
          { text: userMessage },
        ]);

        const response = result.response;
        const text = response.text();

        if (!text) {
          throw new Error("No text response from Gemini");
        }

        return parseAIResponse(text);
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
