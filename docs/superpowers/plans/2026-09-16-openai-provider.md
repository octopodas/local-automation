# OpenAI Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an official OpenAI Responses API provider that authenticates with `OPENAI_API_KEY` and participates in the existing screenshot-driven browser-agent loop.

**Architecture:** A focused `OpenAIProvider` will implement the existing `AIProvider` interface and reuse the shared prompt builders and action parser. Configuration and factory routing will expose `openai` alongside the three existing providers, while the provider sends stateless multimodal Responses API requests with storage disabled.

**Tech Stack:** TypeScript, OpenAI JavaScript SDK, Zod, Vitest, Pino, npm

## Global Constraints

- Target OpenAI's official API only through the official JavaScript SDK and Responses API.
- Authenticate only with `OPENAI_API_KEY`; do not add configurable base URLs.
- Set `store: false` on every request.
- Keep requests stateless and rely on the action history already included by `buildUserMessage()`.
- Retry API, empty-output, and invalid-action failures at most three times.
- Do not log credentials, screenshots, or full DOM snapshots.
- Do not change Anthropic, Gemini, or OpenCode behavior.
- Do not add reasoning controls, conversation persistence, tool calls, fallback routing, or model-selection logic.

---

## File Map

- Create `src/ai/openai.ts`: OpenAI SDK adapter implementing `AIProvider`.
- Create `tests/ai/openai.test.ts`: credential, request-shape, parsing, and retry coverage.
- Modify `src/config/schema.ts`: accept `openai` as an AI provider.
- Modify `src/shared/types.ts`: add `openai` to `AIConfig.provider`.
- Modify `src/ai/provider.ts`: route `openai` to `OpenAIProvider` without changing the explicit OpenCode route.
- Modify `tests/config/loader.test.ts`: regression coverage for OpenAI configuration.
- Modify `tests/ai/provider.test.ts`: factory-selection regression coverage.
- Modify `package.json` and `package-lock.json`: add the official `openai` runtime dependency.
- Modify `.env.example`, `config.yaml.example`, and `README.md`: document key and provider selection.

### Task 1: Accept OpenAI in Configuration

**Files:**
- Modify: `tests/config/loader.test.ts`
- Modify: `src/config/schema.ts:44-48`
- Modify: `src/shared/types.ts:58-62`

**Interfaces:**
- Consumes: `loadConfig(explicitPath?: string): { config: AppConfig; configDir: string }`
- Produces: `AIConfig.provider` supporting `"anthropic" | "gemini" | "opencode" | "openai"`

- [ ] **Step 1: Write the failing configuration test**

Add this test inside `describe("loadConfig", ...)` in `tests/config/loader.test.ts`:

```ts
  it("accepts openai as an AI provider", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(
      configPath,
      `
ai:
  provider: openai
  model: gpt-5.4
sites:
  - name: test-site
    url: https://example.com
    tasks:
      - name: test-task
        prompt: "Extract data"
`
    );

    const { config } = loadConfig(configPath);
    expect(config.ai.provider).toBe("openai");
    expect(config.ai.model).toBe("gpt-5.4");
  });
```

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run:

```bash
npm test -- tests/config/loader.test.ts -t "accepts openai"
```

Expected: FAIL with `Config validation failed` because `openai` is not in the provider enum.

- [ ] **Step 3: Extend the schema and TypeScript union**

Change `src/config/schema.ts` to:

```ts
export const aiSchema = z.object({
  provider: z.enum(["anthropic", "gemini", "opencode", "openai"]),
  model: z.string().min(1),
  maxIterations: z.number().int().min(1).default(20),
});
```

Change `AIConfig` in `src/shared/types.ts` to:

```ts
export interface AIConfig {
  provider: "anthropic" | "gemini" | "opencode" | "openai";
  model: string;
  maxIterations: number;
}
```

- [ ] **Step 4: Run the focused configuration tests**

Run:

```bash
npm test -- tests/config/loader.test.ts
```

Expected: PASS for the complete loader test file.

- [ ] **Step 5: Commit the configuration change**

```bash
git add tests/config/loader.test.ts src/config/schema.ts src/shared/types.ts
git commit -m "feat: accept OpenAI provider configuration"
```

### Task 2: Implement the OpenAI Responses Provider

**Files:**
- Create: `src/ai/openai.ts`
- Create: `tests/ai/openai.test.ts`
- Modify: `tests/ai/provider.test.ts`
- Modify: `src/ai/provider.ts:139-155`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `AIProvider`, `AIResponse`, `parseAIResponse(raw: string)`, `buildSystemPrompt()`, and `buildUserMessage(dom: string, context: TaskContext)` from `src/ai/provider.ts`
- Produces: `new OpenAIProvider(model: string, logger: Logger)` implementing `analyzeScreenshot(screenshot: Buffer, dom: string, context: TaskContext): Promise<AIResponse>`
- Produces: `createAIProvider("openai", model, logger)` returning `OpenAIProvider`

- [ ] **Step 1: Install the official OpenAI runtime dependency**

Run:

```bash
npm install openai
```

Expected: `openai` appears in `dependencies` and npm updates `package-lock.json` without changing unrelated dependencies.

- [ ] **Step 2: Write the failing factory-selection test**

Update the import in `tests/ai/provider.test.ts` to include `createAIProvider`:

```ts
import {
  parseAIResponse,
  buildSystemPrompt,
  buildUserMessage,
  createAIProvider,
} from "../../src/ai/provider.js";
import pino from "pino";
```

Append:

```ts
describe("createAIProvider", () => {
  it("selects the OpenAI provider", async () => {
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";

    try {
      const provider = await createAIProvider(
        "openai",
        "gpt-5.4",
        pino({ level: "silent" })
      );
      expect(provider.constructor.name).toBe("OpenAIProvider");
    } finally {
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
    }
  });
});
```

- [ ] **Step 3: Run the factory test and verify the expected failure**

Run:

```bash
npm test -- tests/ai/provider.test.ts -t "selects the OpenAI provider"
```

Expected: FAIL because `createAIProvider()` currently routes every non-Anthropic/non-Gemini provider to `OpenCodeProvider`.

- [ ] **Step 4: Add the minimal OpenAI class and explicit factory route**

Create `src/ai/openai.ts`:

```ts
import OpenAI from "openai";
import type { Logger } from "pino";
import type { TaskContext } from "../shared/types.js";
import type { AIProvider, AIResponse } from "./provider.js";

export class OpenAIProvider implements AIProvider {
  private client: OpenAI;
  private model: string;
  private logger: Logger;

  constructor(model: string, logger: Logger) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY environment variable is not set");
    }
    this.client = new OpenAI({ apiKey });
    this.model = model;
    this.logger = logger;
  }

  async analyzeScreenshot(
    _screenshot: Buffer,
    _dom: string,
    _context: TaskContext
  ): Promise<AIResponse> {
    throw new Error("OpenAI provider request path is unavailable");
  }
}
```

Change the provider argument and routing in `src/ai/provider.ts` to:

```ts
export async function createAIProvider(
  provider: "anthropic" | "gemini" | "opencode" | "openai",
  model: string,
  logger: Logger
): Promise<AIProvider> {
  if (provider === "anthropic") {
    const { AnthropicProvider } = await import("./anthropic.js");
    return new AnthropicProvider(model, logger);
  } else if (provider === "gemini") {
    const { GeminiProvider } = await import("./gemini.js");
    return new GeminiProvider(model, logger);
  } else if (provider === "openai") {
    const { OpenAIProvider } = await import("./openai.js");
    return new OpenAIProvider(model, logger);
  } else {
    const { OpenCodeProvider } = await import("./opencode.js");
    return new OpenCodeProvider(model, logger);
  }
}
```

- [ ] **Step 5: Run the factory test and verify it passes**

Run:

```bash
npm test -- tests/ai/provider.test.ts -t "selects the OpenAI provider"
```

Expected: PASS.

- [ ] **Step 6: Write the failing provider behavior tests**

Create `tests/ai/openai.test.ts`:

```ts
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
```

- [ ] **Step 7: Run the provider tests and verify the expected failure**

Run:

```bash
npm test -- tests/ai/openai.test.ts
```

Expected: the credential test passes, while request and retry tests fail with `OpenAI provider request path is unavailable`.

- [ ] **Step 8: Implement the Responses API request and retry loop**

Replace `src/ai/openai.ts` with:

```ts
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

export class OpenAIProvider implements AIProvider {
  private client: OpenAI;
  private model: string;
  private logger: Logger;

  constructor(model: string, logger: Logger) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY environment variable is not set");
    }
    this.client = new OpenAI({ apiKey });
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
                { type: "input_image", image_url: imageUrl },
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
        lastError = err as Error;
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
```

- [ ] **Step 9: Run focused tests and build**

Run:

```bash
npm test -- tests/ai/openai.test.ts tests/ai/provider.test.ts
npm run build
```

Expected: both test files PASS and TypeScript compilation exits successfully.

- [ ] **Step 10: Commit the provider implementation**

```bash
git add package.json package-lock.json src/ai/openai.ts src/ai/provider.ts tests/ai/openai.test.ts tests/ai/provider.test.ts
git commit -m "feat: add OpenAI Responses provider"
```

### Task 3: Document OpenAI Setup and Run Full Verification

**Files:**
- Modify: `.env.example`
- Modify: `config.yaml.example`
- Modify: `README.md`

**Interfaces:**
- Consumes: `OPENAI_API_KEY` and `ai.provider: openai` implemented by Tasks 1-2
- Produces: copyable setup examples for the new provider

- [ ] **Step 1: Add documentation assertions**

Because these are plain-text examples rather than executable behavior, use a focused shell assertion after editing. The assertion must require all three files to mention the key or provider:

```bash
rg -n 'OPENAI_API_KEY|provider: openai|"openai"' .env.example config.yaml.example README.md
```

Before editing, expected output is empty for `OPENAI_API_KEY`, `provider: openai`, and `"openai"`.

- [ ] **Step 2: Update the environment example**

Add this immediately after the Gemini key in `.env.example`:

```env
OPENAI_API_KEY=sk-...
```

- [ ] **Step 3: Update the YAML example**

Change the provider comment and add an OpenAI example in `config.yaml.example`:

```yaml
ai:
  provider: anthropic      # "anthropic" | "gemini" | "opencode" | "openai"
  model: claude-sonnet-4-6 # provider-specific model name
  # Official OpenAI Responses API example (needs OPENAI_API_KEY):
  #provider: openai
  #model: gpt-5.4
  # OpenCode Go example (needs OPENCODE_GO_API_KEY):
  #provider: opencode
  #model: minimax-m3
  maxIterations: 20
```

Keep the existing OpenCode comments accurate if the current file differs from this block; use `OPENCODE_GO_API_KEY` consistently with `src/ai/opencode.ts`.

- [ ] **Step 4: Update README provider setup**

Make these exact content changes in `README.md`:

```md
AI-driven browser automation CLI tool for extracting data from web dashboards. Uses Playwright for browser control and AI (Anthropic Claude, Google Gemini, OpenAI, or OpenCode Go) to navigate pages and extract structured data.
```

```md
- An API key for [Anthropic](https://console.anthropic.com/), [Google Gemini](https://aistudio.google.com/apikey), [OpenAI](https://platform.openai.com/api-keys), or OpenCode Go
```

```env
ANTHROPIC_API_KEY=sk-ant-...
# or
GEMINI_API_KEY=AI...
# or
OPENAI_API_KEY=sk-...
```

Change the YAML comment to:

```yaml
ai:
  provider: anthropic       # "anthropic", "gemini", "opencode", or "openai"
  model: claude-sonnet-4-6  # provider-specific model name
  maxIterations: 20
```

After that block, add:

```md
For OpenAI, set `provider: openai`, choose a vision-capable OpenAI model such as `gpt-5.4`, and set `OPENAI_API_KEY` in `.env`. The integration uses OpenAI's Responses API with response storage disabled.
```

- [ ] **Step 5: Verify documentation assertions**

Run:

```bash
rg -n 'OPENAI_API_KEY|provider: openai|"openai"' .env.example config.yaml.example README.md
```

Expected: matches in all three files, including the key example and the provider selection example.

- [ ] **Step 6: Run the complete verification suite**

Run:

```bash
npm test
npm run build
git diff --check
git status --short
```

Expected: all Vitest files pass, TypeScript compilation succeeds, `git diff --check` prints nothing, and status lists only the three documentation files before the documentation commit.

- [ ] **Step 7: Commit documentation**

```bash
git add .env.example config.yaml.example README.md
git commit -m "docs: document OpenAI provider setup"
```

- [ ] **Step 8: Verify the final branch state**

Run:

```bash
git status --short
git log -4 --oneline
```

Expected: the working tree is clean and the latest commits are the documentation, provider, configuration, and design/plan work.
