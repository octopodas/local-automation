import { chromium, type Browser, type Page, type BrowserContext } from "playwright";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { AIProvider } from "../ai/provider.js";
import { executeAction } from "./actions.js";
import type {
  AIAction,
  SiteConfig,
  TaskConfig,
  AIConfig,
  TaskContext,
  ActionHistoryEntry,
  TaskResult,
  ProgressStep,
} from "../shared/types.js";
import type { Logger } from "pino";

const SESSIONS_DIR = resolve(homedir(), ".local-auto", "sessions");

export interface ProgressEvent {
  iteration: number;
  step: ProgressStep;
  message: string;
  thinking?: string;
}

export interface BrowserAgentOptions {
  siteConfig: SiteConfig;
  taskConfig: TaskConfig;
  aiConfig: AIConfig;
  aiProvider: AIProvider;
  logger: Logger;
  onProgress?: (event: ProgressEvent) => void;
}

function actionSummary(action: AIAction): string {
  switch (action.action) {
    case "click": return `click → ${action.selector}`;
    case "type": return `type "${action.text}" → ${action.selector}`;
    case "select": return `select "${action.value}" → ${action.selector}`;
    case "navigate": return `navigate → ${action.url}`;
    case "scroll": return `scroll ${action.direction}`;
    case "wait": return `wait ${action.ms}ms`;
    case "extract": return `extract ${action.format} → ${action.selector}`;
    case "done": return `done`;
  }
}

export async function runBrowserAgent(
  opts: BrowserAgentOptions
): Promise<TaskResult> {
  const { siteConfig, taskConfig, aiConfig, aiProvider, logger, onProgress } = opts;
  const startTime = Date.now();

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    browser = await chromium.launch({ headless: true });

    // Try to restore session
    const sessionPath = resolve(SESSIONS_DIR, `${siteConfig.name}.json`);
    const hasSession = existsSync(sessionPath);

    if (hasSession) {
      logger.info({ site: siteConfig.name }, "Restoring saved session");
      const storageState = JSON.parse(readFileSync(sessionPath, "utf-8"));
      context = await browser.newContext({ storageState });
      onProgress?.({ iteration: 0, step: "session", message: `Restored saved session for ${siteConfig.name}` });
    } else {
      context = await browser.newContext();
      onProgress?.({ iteration: 0, step: "session", message: "Starting new browser session" });
    }

    const page = await context.newPage();

    // Navigate to site
    onProgress?.({ iteration: 0, step: "navigate", message: `Navigating to ${siteConfig.url}` });
    await page.goto(siteConfig.url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Run the AI action loop
    const actionHistory: ActionHistoryEntry[] = [];
    let lastError: string | undefined;
    const maxIterations = aiConfig.maxIterations;

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      // Take screenshot + DOM snapshot
      onProgress?.({ iteration, step: "capture", message: "Capturing page screenshot and DOM" });
      const screenshot = await page.screenshot({ type: "png" });
      const dom = await getAccessibleDom(page);

      // Check if we're on a login page and provide hints
      const loginHints = siteConfig.login && (await isLoginPage(page, siteConfig))
        ? siteConfig.login
        : undefined;

      if (loginHints) {
        onProgress?.({ iteration, step: "login-detect", message: "Login page detected, will provide credentials" });
      }

      // Build context for AI
      const taskContext: TaskContext = {
        siteConfig,
        taskConfig,
        prompt: taskConfig.prompt,
        actionHistory,
        iteration,
        maxIterations,
        loginHints,
        error: lastError,
      };

      // Get AI decision
      onProgress?.({ iteration, step: "ai-request", message: "Requesting AI decision" });
      logger.info({ iteration, maxIterations }, "Requesting AI action");
      const aiResponse = await aiProvider.analyzeScreenshot(screenshot, dom, taskContext);
      const action = aiResponse.action;
      logger.info({ iteration, action: action.action }, "AI returned action");

      if (aiResponse.thinking) {
        logger.info({ iteration }, "AI thinking: %s", aiResponse.thinking.slice(0, 500));
      }

      onProgress?.({
        iteration,
        step: "ai-response",
        message: actionSummary(action),
        thinking: aiResponse.thinking,
      });

      // Handle "done" action
      if (action.action === "done") {
        // Save session after successful task completion
        await saveSession(context, siteConfig.name);

        return {
          success: true,
          data: action.result,
          summary: action.summary,
          durationMs: Date.now() - startTime,
          retries: 0, // retries tracked by task-manager
        };
      }

      // Execute the action
      const result = await executeAction(page, action);

      actionHistory.push({
        action,
        success: result.success,
        error: result.error,
      });

      if (result.success) {
        lastError = undefined;
        onProgress?.({ iteration, step: "action-result", message: "Action succeeded" });
        // Wait briefly for page to settle after action
        await page.waitForTimeout(300);
      } else {
        lastError = result.error;
        onProgress?.({ iteration, step: "action-result", message: `Action failed: ${result.error}` });
        logger.warn(
          { iteration, action: action.action, error: result.error },
          "Action failed"
        );
      }
    }

    throw new Error(
      `Max iterations (${maxIterations}) reached without completing the task`
    );
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Get a simplified DOM representation.
 * Uses aria snapshot if available, falls back to cleaned HTML.
 */
async function getAccessibleDom(page: Page): Promise<string> {
  try {
    // Use Playwright's ariaSnapshot for a semantic tree
    const snapshot = await page.locator("body").ariaSnapshot();
    if (snapshot && snapshot.length > 100) {
      return snapshot.slice(0, 50000);
    }
  } catch {
    // ariaSnapshot not available, fall through to HTML
  }

  // Fallback: cleaned HTML
  const html = await page.evaluate(() => {
    const clone = document.documentElement.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("script, style, noscript, svg").forEach((el) => el.remove());
    return clone.outerHTML;
  });

  return html.slice(0, 50000);
}

async function isLoginPage(page: Page, siteConfig: SiteConfig): Promise<boolean> {
  if (!siteConfig.login) return false;

  try {
    const loginField = await page.$(siteConfig.login.usernameField);
    return loginField !== null;
  } catch {
    return false;
  }
}

async function saveSession(context: BrowserContext, siteName: string): Promise<void> {
  try {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    const state = await context.storageState();
    writeFileSync(
      resolve(SESSIONS_DIR, `${siteName}.json`),
      JSON.stringify(state, null, 2)
    );
  } catch {
    // Non-fatal — session save failure shouldn't break the task
  }
}
