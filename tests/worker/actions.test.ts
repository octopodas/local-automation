import { describe, it, expect, vi } from "vitest";
import { executeAction } from "../../src/worker/actions.js";
import type { Page } from "playwright";

function createMockPage(): Page {
  return {
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockResolvedValue(undefined),
    mouse: {
      wheel: vi.fn().mockResolvedValue(undefined),
    },
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue({
      textContent: vi.fn().mockResolvedValue("Hello World"),
      innerHTML: vi.fn().mockResolvedValue("<b>Hello</b>"),
    }),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-screenshot")),
    evaluate: vi.fn().mockResolvedValue([{ Name: "Alice", Score: "100" }]),
  } as unknown as Page;
}

describe("executeAction", () => {
  it("handles click action", async () => {
    const page = createMockPage();
    const result = await executeAction(page, {
      action: "click",
      selector: "#btn",
    });
    expect(result.success).toBe(true);
    expect(page.click).toHaveBeenCalledWith("#btn", { timeout: 10000 });
  });

  it("handles type action", async () => {
    const page = createMockPage();
    const result = await executeAction(page, {
      action: "type",
      selector: "#email",
      text: "test@example.com",
    });
    expect(result.success).toBe(true);
    expect(page.fill).toHaveBeenCalledWith("#email", "test@example.com", {
      timeout: 10000,
    });
  });

  it("handles select action", async () => {
    const page = createMockPage();
    const result = await executeAction(page, {
      action: "select",
      selector: "#dropdown",
      value: "option1",
    });
    expect(result.success).toBe(true);
    expect(page.selectOption).toHaveBeenCalledWith("#dropdown", "option1", {
      timeout: 10000,
    });
  });

  it("handles navigate action", async () => {
    const page = createMockPage();
    const result = await executeAction(page, {
      action: "navigate",
      url: "https://example.com",
    });
    expect(result.success).toBe(true);
    expect(page.goto).toHaveBeenCalledWith("https://example.com", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
  });

  it("handles scroll down action", async () => {
    const page = createMockPage();
    const result = await executeAction(page, {
      action: "scroll",
      direction: "down",
      amount: 300,
    });
    expect(result.success).toBe(true);
    expect(page.mouse.wheel).toHaveBeenCalledWith(0, 300);
  });

  it("handles scroll with default amount", async () => {
    const page = createMockPage();
    const result = await executeAction(page, {
      action: "scroll",
      direction: "up",
    });
    expect(result.success).toBe(true);
    expect(page.mouse.wheel).toHaveBeenCalledWith(0, -500);
  });

  it("handles wait action", async () => {
    const page = createMockPage();
    const result = await executeAction(page, {
      action: "wait",
      ms: 2000,
    });
    expect(result.success).toBe(true);
    expect(page.waitForTimeout).toHaveBeenCalledWith(2000);
  });

  it("handles extract text action", async () => {
    const page = createMockPage();
    const result = await executeAction(page, {
      action: "extract",
      selector: "#content",
      format: "text",
    });
    expect(result.success).toBe(true);
    expect(result.data).toBe("Hello World");
  });

  it("handles extract html action", async () => {
    const page = createMockPage();
    const result = await executeAction(page, {
      action: "extract",
      selector: "#content",
      format: "html",
    });
    expect(result.success).toBe(true);
    expect(result.data).toBe("<b>Hello</b>");
  });

  it("handles extract table action", async () => {
    const page = createMockPage();
    const result = await executeAction(page, {
      action: "extract",
      selector: "table",
      format: "table",
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual([{ Name: "Alice", Score: "100" }]);
  });

  it("handles done action", async () => {
    const page = createMockPage();
    const result = await executeAction(page, {
      action: "done",
      result: { dau: 12450 },
      summary: "Extracted DAU",
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ dau: 12450 });
  });

  it("handles click failure gracefully", async () => {
    const page = createMockPage();
    (page.click as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Element not found")
    );
    const result = await executeAction(page, {
      action: "click",
      selector: "#nonexistent",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Element not found");
  });

  it("handles extract with null element", async () => {
    const page = createMockPage();
    (page.waitForSelector as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const result = await executeAction(page, {
      action: "extract",
      selector: "#missing",
      format: "text",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Element not found");
  });
});
