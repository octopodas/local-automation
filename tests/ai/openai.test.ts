import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { OpenAIProvider } from "../../src/ai/openai.js";
import type { TaskContext } from "../../src/shared/types.js";

const { responsesCreate, sdkConstruct } = vi.hoisted(() => ({
  responsesCreate: vi.fn(),
  sdkConstruct: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    responses = { create: responsesCreate };

    constructor(options: unknown) {
      sdkConstruct(options);
    }
  },
}));

const context: TaskContext = {
  siteConfig: { name: "test", url: "https://example.com", tasks: [] },
  taskConfig: {
    name: "test",
    prompt: "Extract metrics",
    output: { webhooks: false },
    retry: { maxAttempts: 3, backoffMs: 5000 },
  },
  prompt: "Extract metrics",
  actionHistory: [],
  iteration: 1,
  maxIterations: 20,
};

const logger = pino({ level: "silent" });

describe("OpenAIProvider", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    responsesCreate.mockReset();
    sdkConstruct.mockReset();
    responsesCreate.mockResolvedValue({
      output_text: '{"action":"wait","ms":1}',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("requires OPENAI_API_KEY", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(() => new OpenAIProvider("gpt-5.4", logger)).toThrow(
      "OPENAI_API_KEY environment variable is not set"
    );
  });

  it("sends a stateless multimodal Responses API request", async () => {
    const provider = new OpenAIProvider("gpt-5.4", logger);
    const result = await provider.analyzeScreenshot(
      Buffer.from("image"),
      "<main>Revenue: 42</main>",
      context
    );

    expect(sdkConstruct).toHaveBeenCalledWith({ apiKey: "test-key" });
    expect(responsesCreate).toHaveBeenCalledWith({
      model: "gpt-5.4",
      store: false,
      max_output_tokens: 4096,
      instructions: expect.stringContaining("browser automation agent"),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: `data:image/png;base64,${Buffer.from("image").toString("base64")}`,
              detail: "auto",
            },
            {
              type: "input_text",
              text: expect.stringContaining("<main>Revenue: 42</main>"),
            },
          ],
        },
      ],
    });
    expect(result).toEqual({ action: { action: "wait", ms: 1 } });
  });

  it("retries after an API failure", async () => {
    responsesCreate
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({ output_text: '{"action":"wait","ms":1}' });

    const provider = new OpenAIProvider("gpt-5.4", logger);
    await expect(
      provider.analyzeScreenshot(Buffer.from("image"), "<html/>", context)
    ).resolves.toEqual({ action: { action: "wait", ms: 1 } });
    expect(responsesCreate).toHaveBeenCalledTimes(2);
  });

  it("retries after an empty response", async () => {
    responsesCreate
      .mockResolvedValueOnce({ output_text: "" })
      .mockResolvedValueOnce({ output_text: '{"action":"wait","ms":1}' });

    const provider = new OpenAIProvider("gpt-5.4", logger);
    await expect(
      provider.analyzeScreenshot(Buffer.from("image"), "<html/>", context)
    ).resolves.toEqual({ action: { action: "wait", ms: 1 } });
    expect(responsesCreate).toHaveBeenCalledTimes(2);
  });

  it("fails after three invalid responses", async () => {
    responsesCreate.mockResolvedValue({ output_text: "not-json" });

    const provider = new OpenAIProvider("gpt-5.4", logger);
    await expect(
      provider.analyzeScreenshot(Buffer.from("image"), "<html/>", context)
    ).rejects.toThrow("Failed to get valid AI action after 3 attempts");
    expect(responsesCreate).toHaveBeenCalledTimes(3);
  });
});
