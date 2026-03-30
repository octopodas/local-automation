import type { Page } from "playwright";
import type { AIAction } from "../shared/types.js";

export interface ActionResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Execute an AI action against a Playwright page.
 * Returns the result of the action execution.
 */
export async function executeAction(
  page: Page,
  action: AIAction
): Promise<ActionResult> {
  try {
    switch (action.action) {
      case "click": {
        await page.click(action.selector, { timeout: 30000 });
        return { success: true };
      }

      case "type": {
        await page.fill(action.selector, action.text, { timeout: 30000 });
        return { success: true };
      }

      case "select": {
        await page.selectOption(action.selector, action.value, { timeout: 30000 });
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
            data = await page.evaluate((sel) => {
              const table = document.querySelector(sel);
              if (!table) return [];
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
            }, action.selector);
            break;
        }

        return { success: true, data };
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
