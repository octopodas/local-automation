import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { OpenCodeProvider } from "../../src/ai/opencode.js";
import type { TaskContext } from "../../src/shared/types.js";

const context: TaskContext = {
  siteConfig: { name: "test", url: "https://example.com", tasks: [] },
  taskConfig: {
    name: "test", prompt: "Extract metrics", output: { webhooks: false },
    retry: { maxAttempts: 3, backoffMs: 5000 },
  },
  prompt: "Extract metrics", actionHistory: [], iteration: 1, maxIterations: 20,
};
const logger = pino({ level: "silent" });
const fetchMock = vi.fn<typeof fetch>();
const success = () => Response.json({
  choices: [{ message: { content: '{"action":"wait","ms":1}' } }],
});
const headersAt = (index: number) => new Headers(fetchMock.mock.calls[index][1]?.headers);

describe("OpenCode request sessions", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCODE_GO_API_KEY", "test-key");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementation(async () => success());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fetchMock.mockReset();
  });

  it("keeps one session across retries and browser steps", async () => {
    fetchMock.mockResolvedValueOnce(new Response("temporary failure", { status: 503 }));
    const provider = new OpenCodeProvider("test-model", logger);
    await provider.analyzeScreenshot(Buffer.from("image"), "<html/>", context);
    await provider.analyzeScreenshot(Buffer.from("image"), "<html/>", { ...context, iteration: 2 });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const session = headersAt(0).get("x-opencode-session");
    expect(session).toEqual(expect.any(String));
    expect(session).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    for (let i = 0; i < 3; i++) {
      expect(headersAt(i).get("x-opencode-session")).toBe(session);
      expect(headersAt(i).get("user-agent")).toBe("local-auto/0.1.0");
      expect(headersAt(i).get("authorization")).toBe("Bearer test-key");
    }
  });

  it("uses different sessions for separate task providers", async () => {
    for (let i = 0; i < 2; i++) {
      await new OpenCodeProvider("test-model", logger)
        .analyzeScreenshot(Buffer.from("image"), "<html/>", context);
    }
    expect(headersAt(0).get("x-opencode-session")).toEqual(expect.any(String));
    expect(headersAt(0).get("x-opencode-session")).not.toBe(headersAt(1).get("x-opencode-session"));
  });
});
