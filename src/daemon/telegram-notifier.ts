import type { TelegramConfig, TaskRun, TaskResult } from "../shared/types.js";
import type { Logger } from "pino";

export class TelegramNotifier {
  private botToken: string;
  private chatId: string;
  private logger: Logger;

  constructor(config: TelegramConfig, logger: Logger) {
    this.botToken = config.botToken;
    this.chatId = config.chatId;
    this.logger = logger;
  }

  async notify(run: TaskRun, result: TaskResult): Promise<void> {
    const icon = result.success ? "\u2705" : "\u274C";
    const status = result.success ? "completed" : "failed";

    const lines = [
      `${icon} <b>Task ${status}</b>`,
      ``,
      `<b>Site:</b> ${escapeHtml(run.site)}`,
      `<b>Task:</b> ${escapeHtml(run.task)}`,
      `<b>Trigger:</b> ${run.triggeredBy}`,
      `<b>Duration:</b> ${(result.durationMs / 1000).toFixed(1)}s`,
    ];

    if (result.data && Object.keys(result.data).length > 0) {
      const table = formatDataTable(result.data);
      if (table) {
        lines.push(``, `<pre>${escapeHtml(table)}</pre>`);
      }
    }

    if (result.summary) {
      lines.push(``, `<b>Summary:</b> ${escapeHtml(result.summary)}`);
    }

    if (!result.success && run.error) {
      lines.push(``, `<b>Error:</b> ${escapeHtml(run.error)}`);
    }

    const text = lines.join("\n");

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: "HTML",
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        this.logger.error(
          { status: response.status, body },
          "Telegram notification failed"
        );
      } else {
        this.logger.info("Telegram notification sent");
      }
    } catch (err) {
      this.logger.error(
        { error: (err as Error).message },
        "Telegram notification error"
      );
    }
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Format result data as an aligned text table.
 * Handles nested objects (sites with breakdowns) and flat key-value data.
 */
function formatDataTable(data: Record<string, unknown>): string | null {
  const rows: string[][] = [];

  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      // Nested object — site with breakdown
      rows.push([`── ${key} ──`, ""]);
      for (const [subKey, subVal] of Object.entries(value as Record<string, unknown>)) {
        if (subVal && typeof subVal === "object" && !Array.isArray(subVal)) {
          // Another level deep
          rows.push([`  ${subKey}`, ""]);
          for (const [k, v] of Object.entries(subVal as Record<string, unknown>)) {
            rows.push([`    ${k}`, String(v ?? "")]);
          }
        } else {
          rows.push([`  ${subKey}`, String(subVal ?? "")]);
        }
      }
    } else if (Array.isArray(value)) {
      // Array of objects — render as rows
      rows.push([`── ${key} ──`, ""]);
      for (const item of value) {
        if (item && typeof item === "object") {
          for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
            rows.push([`  ${k}`, String(v ?? "")]);
          }
          rows.push(["", ""]);
        } else {
          rows.push([`  •`, String(item)]);
        }
      }
    } else {
      rows.push([key, String(value ?? "")]);
    }
  }

  if (rows.length === 0) return null;

  // Align columns
  const maxKeyLen = Math.max(...rows.map(([k]) => k.length));
  return rows
    .map(([k, v]) => (v ? `${k.padEnd(maxKeyLen)}  ${v}` : k))
    .join("\n");
}
