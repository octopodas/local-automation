import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { Command } from "commander";

const DATA_DIR = resolve(homedir(), ".local-auto");
const AUTH_TOKEN_PATH = resolve(DATA_DIR, "auth-token");
const PID_PATH = resolve(DATA_DIR, "daemon.pid");

export function getAuthToken(): string {
  if (!existsSync(AUTH_TOKEN_PATH)) {
    throw new Error("Auth token not found. Is the daemon running? Start it with: local-auto start");
  }
  return readFileSync(AUTH_TOKEN_PATH, "utf-8").trim();
}

export function getDaemonPid(): number | null {
  if (!existsSync(PID_PATH)) return null;
  const pid = parseInt(readFileSync(PID_PATH, "utf-8").trim(), 10);
  if (isNaN(pid)) return null;

  // Check if process is actually running
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

export function getDaemonUrl(): string {
  // Default; could be read from config in the future
  return "http://127.0.0.1:3847";
}

export async function apiRequest(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; data: unknown }> {
  const token = getAuthToken();
  const url = `${getDaemonUrl()}${path}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (body) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data: unknown;
  const text = await response.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return { status: response.status, data };
}

export function getFormat(cmd: Command): string {
  // Walk up parent chain to find the --format option
  let current: Command | null = cmd;
  while (current) {
    const opts = current.opts();
    if (opts.format) return opts.format;
    current = current.parent;
  }
  return "text";
}

export function output(data: unknown, format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    if (typeof data === "string") {
      console.log(data);
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
  }
}
