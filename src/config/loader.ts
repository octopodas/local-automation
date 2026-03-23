import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { config as loadDotenv } from "dotenv";
import { appConfigSchema } from "./schema.js";
import type { AppConfig } from "../shared/types.js";

/**
 * Resolve env var references like ${VAR_NAME} in strings.
 * Recursively processes objects and arrays.
 */
export function resolveEnvVars(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([^}]+)\}/g, (_, varName: string) => {
      const envVal = process.env[varName];
      if (envVal === undefined) {
        throw new Error(`Environment variable ${varName} is not set`);
      }
      return envVal;
    });
  }
  if (Array.isArray(value)) {
    return value.map(resolveEnvVars);
  }
  if (value !== null && typeof value === "object") {
    const resolved: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      resolved[k] = resolveEnvVars(v);
    }
    return resolved;
  }
  return value;
}

/**
 * Find config file in order:
 * 1. Explicit path (--config flag)
 * 2. ./config.yaml (cwd)
 * 3. ~/.local-auto/config.yaml
 */
export function findConfigPath(explicitPath?: string): string {
  if (explicitPath) {
    const resolved = resolve(explicitPath);
    if (!existsSync(resolved)) {
      throw new Error(`Config file not found: ${resolved}`);
    }
    return resolved;
  }

  const cwdPath = resolve("config.yaml");
  if (existsSync(cwdPath)) {
    return cwdPath;
  }

  const homePath = resolve(homedir(), ".local-auto", "config.yaml");
  if (existsSync(homePath)) {
    return homePath;
  }

  throw new Error(
    "No config.yaml found. Looked in:\n" +
      `  1. ./config.yaml\n` +
      `  2. ~/.local-auto/config.yaml\n` +
      "Create one from config.yaml.example to get started."
  );
}

/**
 * Load and validate the application config.
 * Returns the parsed config and the directory containing the config file.
 */
export function loadConfig(explicitPath?: string): {
  config: AppConfig;
  configDir: string;
} {
  // Load .env file if present (from cwd)
  loadDotenv();

  const configPath = findConfigPath(explicitPath);
  const configDir = dirname(configPath);

  const raw = readFileSync(configPath, "utf-8");
  const parsed = parseYaml(raw);

  // Resolve env var references
  const resolved = resolveEnvVars(parsed);

  // Validate with zod
  const result = appConfigSchema.safeParse(resolved);
  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Config validation failed:\n${errors}`);
  }

  return { config: result.data as AppConfig, configDir };
}
