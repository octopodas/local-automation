import type { Page } from "playwright";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import type { AIAction } from "../shared/types.js";

const DOWNLOADS_DIR = resolve(homedir(), "Downloads");

export interface ActionResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

function normalizeSelector(selector: string): string {
  let normalized = selector.replace(/:contains\((['"]?)(.*?)\1\)/g, ':has-text("$2")');
  const buttonHasTextRegex = /button:has-text\((['"]?)(.*?)\1\)/g;
  if (buttonHasTextRegex.test(normalized)) {
    normalized = normalized.replace(buttonHasTextRegex, 'role=button[name="$2"]');
  }
  return normalized;
}

/**
 * Execute an AI action against a Playwright page.
 * Returns the result of the action execution.
 */
export async function executeAction(
  page: Page,
  action: AIAction
): Promise<ActionResult> {
  if ("selector" in action && typeof action.selector === "string") {
    (action as any).selector = normalizeSelector(action.selector);
  }
  try {
    switch (action.action) {
      case "click": {
        await page.locator(action.selector).first().click({ timeout: 30000 });
        return { success: true };
      }

      case "type": {
        await page.locator(action.selector).first().fill(action.text, { timeout: 30000 });
        return { success: true };
      }

      case "select": {
        await page.locator(action.selector).first().selectOption(action.value, { timeout: 30000 });
        return { success: true };
      }

      case "navigate": {
        await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        return { success: true };
      }

      case "scroll": {
        const amount = action.amount ?? 500;
        const deltaX =
          action.direction === "left"
            ? -amount
            : action.direction === "right"
              ? amount
              : 0;
        const deltaY =
          action.direction === "up"
            ? -amount
            : action.direction === "down"
              ? amount
              : 0;
        await page.mouse.wheel(deltaX, deltaY);
        // Wait for any lazy-loaded content
        await page.waitForTimeout(500);
        return { success: true };
      }

      case "wait": {
        await page.waitForTimeout(action.ms);
        return { success: true };
      }

      case "extract": {
        const element = await page.waitForSelector(action.selector, { timeout: 30000 });
        if (!element) {
          return { success: false, error: `Element not found: ${action.selector}` };
        }

        let data: unknown;
        switch (action.format) {
          case "text":
            data = await element.textContent();
            break;
          case "html":
            data = await element.innerHTML();
            break;
          case "table":
            data = await element.evaluate((table) => {
              const rows = table.querySelectorAll("tr");
              const headers: string[] = [];
              const result: Record<string, string>[] = [];

              rows.forEach((row, i) => {
                const cells = row.querySelectorAll("th, td");
                if (i === 0) {
                  cells.forEach((cell) => headers.push(cell.textContent?.trim() ?? ""));
                } else {
                  const rowData: Record<string, string> = {};
                  cells.forEach((cell, j) => {
                    rowData[headers[j] ?? `col${j}`] = cell.textContent?.trim() ?? "";
                  });
                  result.push(rowData);
                }
              });

              return result;
            });
            break;
        }

        return { success: true, data };
      }

      case "download": {
        mkdirSync(DOWNLOADS_DIR, { recursive: true });
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: 30000 }),
          page.locator(action.selector).first().click({ timeout: 30000 }),
        ]);
        const filename = download.suggestedFilename();
        const filePath = resolve(DOWNLOADS_DIR, filename);
        await download.saveAs(filePath);
        return { success: true, data: { filePath, filename } };
      }

      case "done": {
        // Done is handled by the browser agent loop, not here
        return { success: true, data: action.result };
      }

      default:
        return {
          success: false,
          error: `Unknown action: ${(action as { action: string }).action}`,
        };
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
