import pino from "pino";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function createLogger(opts: {
  name?: string;
  level?: string;
  filePath?: string;
}): pino.Logger {
  const { name = "local-auto", level = "info", filePath } = opts;

  if (filePath) {
    mkdirSync(dirname(filePath), { recursive: true });
    return pino(
      { name, level },
      pino.destination({ dest: filePath, sync: false })
    );
  }

  // Pretty print to stdout for development
  return pino({
    name,
    level,
    transport: {
      target: "pino-pretty",
      options: { colorize: true },
    },
  });
}
