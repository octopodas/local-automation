#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { registerStartCommand } from "./commands/start.js";
import { registerStopCommand } from "./commands/stop.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerRunCommand } from "./commands/run.js";
import { registerListCommand } from "./commands/list.js";
import { registerLogsCommand } from "./commands/logs.js";
import { registerWebhookCommand } from "./commands/webhook.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read version from package.json
let version = "0.0.0";
try {
  const pkgPath = resolve(__dirname, "../../package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  version = pkg.version;
} catch {
  // OK
}

const program = new Command();

program
  .name("local-auto")
  .description("Local automation CLI — AI-driven browser data extraction")
  .version(version)
  .option("--config <path>", "Path to config.yaml")
  .option("--format <format>", "Output format: text or json", "text");

registerStartCommand(program);
registerStopCommand(program);
registerStatusCommand(program);
registerRunCommand(program);
registerListCommand(program);
registerLogsCommand(program);
registerWebhookCommand(program);

program.parse();
