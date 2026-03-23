import { describe, it, expect } from "vitest";
import { parseAIResponse, buildSystemPrompt, buildUserMessage } from "../../src/ai/provider.js";
import type { TaskContext } from "../../src/shared/types.js";

describe("parseAIResponse", () => {
  it("parses a click action", () => {
    const result = parseAIResponse('{"action":"click","selector":"#submit"}');
    expect(result).toEqual({ action: "click", selector: "#submit" });
  });

  it("parses a type action", () => {
    const result = parseAIResponse(
      '{"action":"type","selector":"#email","text":"user@example.com"}'
    );
    expect(result).toEqual({
      action: "type",
      selector: "#email",
      text: "user@example.com",
    });
  });

  it("parses a done action with result", () => {
    const result = parseAIResponse(
      '{"action":"done","result":{"dau":12450},"summary":"Extracted DAU"}'
    );
    expect(result).toEqual({
      action: "done",
      result: { dau: 12450 },
      summary: "Extracted DAU",
    });
  });

  it("parses a scroll action", () => {
    const result = parseAIResponse(
      '{"action":"scroll","direction":"down","amount":500}'
    );
    expect(result).toEqual({ action: "scroll", direction: "down", amount: 500 });
  });

  it("parses an extract action", () => {
    const result = parseAIResponse(
      '{"action":"extract","selector":"table.metrics","format":"table"}'
    );
    expect(result).toEqual({
      action: "extract",
      selector: "table.metrics",
      format: "table",
    });
  });

  it("parses a navigate action", () => {
    const result = parseAIResponse(
      '{"action":"navigate","url":"https://example.com/metrics"}'
    );
    expect(result).toEqual({
      action: "navigate",
      url: "https://example.com/metrics",
    });
  });

  it("parses a select action", () => {
    const result = parseAIResponse(
      '{"action":"select","selector":"#dropdown","value":"option1"}'
    );
    expect(result).toEqual({
      action: "select",
      selector: "#dropdown",
      value: "option1",
    });
  });

  it("parses a wait action", () => {
    const result = parseAIResponse('{"action":"wait","ms":2000}');
    expect(result).toEqual({ action: "wait", ms: 2000 });
  });

  it("strips markdown code fences", () => {
    const result = parseAIResponse(
      '```json\n{"action":"click","selector":"#btn"}\n```'
    );
    expect(result).toEqual({ action: "click", selector: "#btn" });
  });

  it("strips code fences without json label", () => {
    const result = parseAIResponse(
      '```\n{"action":"click","selector":"#btn"}\n```'
    );
    expect(result).toEqual({ action: "click", selector: "#btn" });
  });

  it("throws on invalid JSON", () => {
    expect(() => parseAIResponse("not json")).toThrow("Failed to parse AI response");
  });

  it("throws on invalid action type", () => {
    expect(() =>
      parseAIResponse('{"action":"fly","destination":"moon"}')
    ).toThrow("Invalid AI action");
  });

  it("throws on missing required fields", () => {
    expect(() => parseAIResponse('{"action":"click"}')).toThrow(
      "Invalid AI action"
    );
  });
});

describe("buildSystemPrompt", () => {
  it("returns a non-empty string with action types", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("click");
    expect(prompt).toContain("done");
    expect(prompt).toContain("extract");
    expect(prompt.length).toBeGreaterThan(100);
  });
});

describe("buildUserMessage", () => {
  const baseContext: TaskContext = {
    siteConfig: {
      name: "test-site",
      url: "https://example.com",
      tasks: [],
    },
    taskConfig: {
      name: "test-task",
      prompt: "Extract metrics",
      output: { webhooks: false },
      retry: { maxAttempts: 3, backoffMs: 5000 },
    },
    prompt: "Extract metrics from the dashboard",
    actionHistory: [],
    iteration: 1,
    maxIterations: 20,
  };

  it("includes task prompt", () => {
    const msg = buildUserMessage("<html></html>", baseContext);
    expect(msg).toContain("Extract metrics from the dashboard");
  });

  it("includes site info", () => {
    const msg = buildUserMessage("<html></html>", baseContext);
    expect(msg).toContain("test-site");
    expect(msg).toContain("https://example.com");
  });

  it("includes iteration count", () => {
    const msg = buildUserMessage("<html></html>", baseContext);
    expect(msg).toContain("1/20");
  });

  it("includes login hints when present", () => {
    const ctx = {
      ...baseContext,
      loginHints: {
        type: "form" as const,
        usernameField: "#email",
        passwordField: "#pass",
        submitButton: "#login",
        credentials: { username: "user", password: "pass" },
      },
    };
    const msg = buildUserMessage("<html></html>", ctx);
    expect(msg).toContain("#email");
    expect(msg).toContain("#pass");
  });

  it("includes error from previous action", () => {
    const ctx = { ...baseContext, error: "Element not found: #missing" };
    const msg = buildUserMessage("<html></html>", ctx);
    expect(msg).toContain("Element not found: #missing");
  });

  it("includes action history", () => {
    const ctx = {
      ...baseContext,
      actionHistory: [
        {
          action: { action: "click" as const, selector: "#btn" },
          success: true,
        },
        {
          action: { action: "click" as const, selector: "#missing" },
          success: false,
          error: "Not found",
        },
      ],
    };
    const msg = buildUserMessage("<html></html>", ctx);
    expect(msg).toContain("Action history");
    expect(msg).toContain("#btn");
    expect(msg).toContain("FAILED");
  });

  it("includes DOM snapshot", () => {
    const msg = buildUserMessage("<div>test content</div>", baseContext);
    expect(msg).toContain("test content");
  });
});
