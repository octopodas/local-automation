import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveEnvVars, findConfigPath, loadConfig } from "../../src/config/loader.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("resolveEnvVars", () => {
  beforeEach(() => {
    process.env.TEST_USER = "alice";
    process.env.TEST_PASS = "secret123";
  });

  afterEach(() => {
    delete process.env.TEST_USER;
    delete process.env.TEST_PASS;
  });

  it("resolves env vars in strings", () => {
    expect(resolveEnvVars("hello ${TEST_USER}")).toBe("hello alice");
  });

  it("resolves multiple env vars in one string", () => {
    expect(resolveEnvVars("${TEST_USER}:${TEST_PASS}")).toBe("alice:secret123");
  });

  it("passes through strings without env vars", () => {
    expect(resolveEnvVars("no vars here")).toBe("no vars here");
  });

  it("passes through non-string values", () => {
    expect(resolveEnvVars(42)).toBe(42);
    expect(resolveEnvVars(true)).toBe(true);
    expect(resolveEnvVars(null)).toBe(null);
  });

  it("recursively resolves objects", () => {
    const input = {
      user: "${TEST_USER}",
      nested: { pass: "${TEST_PASS}" },
    };
    expect(resolveEnvVars(input)).toEqual({
      user: "alice",
      nested: { pass: "secret123" },
    });
  });

  it("recursively resolves arrays", () => {
    const input = ["${TEST_USER}", "literal", "${TEST_PASS}"];
    expect(resolveEnvVars(input)).toEqual(["alice", "literal", "secret123"]);
  });

  it("throws on missing env var", () => {
    expect(() => resolveEnvVars("${NONEXISTENT_VAR}")).toThrow(
      "Environment variable NONEXISTENT_VAR is not set"
    );
  });
});

describe("findConfigPath", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `local-auto-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns explicit path when file exists", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(configPath, "daemon:\n  port: 3847\n");
    expect(findConfigPath(configPath)).toBe(configPath);
  });

  it("throws when explicit path does not exist", () => {
    expect(() => findConfigPath(join(tmpDir, "nonexistent.yaml"))).toThrow(
      "Config file not found"
    );
  });

  it("throws when no config found anywhere", () => {
    // Use a non-existent cwd-relative path by passing no arg and ensuring neither location exists
    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      expect(() => findConfigPath()).toThrow("No config.yaml found");
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe("loadConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `local-auto-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    process.env.TEST_USER = "alice";
    process.env.TEST_PASS = "secret123";
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.TEST_USER;
    delete process.env.TEST_PASS;
  });

  it("loads and validates a valid config", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(
      configPath,
      `
ai:
  provider: anthropic
  model: claude-sonnet-4-6
sites:
  - name: test-site
    url: https://example.com
    tasks:
      - name: test-task
        prompt: "Extract data"
`
    );

    const { config, configDir } = loadConfig(configPath);
    expect(config.ai.provider).toBe("anthropic");
    expect(config.sites[0].name).toBe("test-site");
    expect(config.daemon.port).toBe(3847); // default
    expect(configDir).toBe(tmpDir);
  });

  it("resolves env vars in config", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(
      configPath,
      `
ai:
  provider: anthropic
  model: claude-sonnet-4-6
sites:
  - name: test-site
    url: https://example.com
    login:
      type: form
      usernameField: "#user"
      passwordField: "#pass"
      submitButton: "#submit"
      credentials:
        username: \${TEST_USER}
        password: \${TEST_PASS}
    tasks:
      - name: test-task
        prompt: "Extract data"
`
    );

    const { config } = loadConfig(configPath);
    expect(config.sites[0].login?.credentials.username).toBe("alice");
    expect(config.sites[0].login?.credentials.password).toBe("secret123");
  });

  it("throws on invalid config", () => {
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(configPath, `ai:\n  provider: invalid-provider\n`);

    expect(() => loadConfig(configPath)).toThrow("Config validation failed");
  });
});
