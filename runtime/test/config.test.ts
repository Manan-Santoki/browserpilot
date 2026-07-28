import { describe, expect, test } from "bun:test";
import { credentialEnv, loadConfig } from "../src/config";

const base = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/browserpilot",
  BP_MASTER_KEY: "m".repeat(44),
  BP_TICKET_SECRET: "t".repeat(44),
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
};

describe("loadConfig", () => {
  test("applies defaults", () => {
    const cfg = loadConfig(base);
    expect(cfg.port).toBe(8787);
    expect(cfg.model).toBe("claude-opus-5");
    expect(cfg.nodeBin).toBe("node");
    expect(cfg.downloadsRoot).toBe("./downloads");
    expect(cfg.aiCredential).toEqual({ kind: "oauth", value: "oauth-token" });
  });

  test("carries the database and secrets through", () => {
    const cfg = loadConfig(base);
    expect(cfg.databaseUrl).toBe(base.DATABASE_URL);
    expect(cfg.masterKey).toBe(base.BP_MASTER_KEY);
    expect(cfg.ticketSecret).toBe(base.BP_TICKET_SECRET);
  });

  test("no longer accepts a hardcoded target — sites come from the database", () => {
    const cfg = loadConfig({ ...base, BP_JWM_URL: "https://jwm.example.com" });
    expect(cfg).not.toHaveProperty("jwmUrl");
    expect(JSON.stringify(cfg)).not.toContain("jwm.example.com");
  });

  test("prefers the OAuth token when both credentials are set", () => {
    expect(loadConfig({ ...base, ANTHROPIC_API_KEY: "sk-ant-xxx" }).aiCredential.kind).toBe("oauth");
  });

  test("falls back to the API key", () => {
    const { CLAUDE_CODE_OAUTH_TOKEN: _drop, ...noOauth } = base;
    expect(loadConfig({ ...noOauth, ANTHROPIC_API_KEY: "sk-ant-xxx" }).aiCredential).toEqual({
      kind: "apiKey",
      value: "sk-ant-xxx",
    });
  });

  test("throws when no AI credential is set", () => {
    const { CLAUDE_CODE_OAUTH_TOKEN: _drop, ...noCred } = base;
    expect(() => loadConfig(noCred)).toThrow(/CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY/);
  });

  test("throws when DATABASE_URL is missing", () => {
    const { DATABASE_URL: _drop, ...noDb } = base;
    expect(() => loadConfig(noDb)).toThrow(/DATABASE_URL/);
  });

  test("throws when the ticket secret is missing", () => {
    const { BP_TICKET_SECRET: _drop, ...noTicket } = base;
    expect(() => loadConfig(noTicket)).toThrow(/BP_TICKET_SECRET/);
  });

  test("rejects a master key too short to encrypt with", () => {
    expect(() => loadConfig({ ...base, BP_MASTER_KEY: "short" })).toThrow(/at least 32/i);
  });

  test("numeric and path overrides are honoured", () => {
    const cfg = loadConfig({ ...base, BP_PORT: "9000", BP_NODE_BIN: "/usr/bin/node" });
    expect(cfg.port).toBe(9000);
    expect(cfg.nodeBin).toBe("/usr/bin/node");
  });
});

describe("credentialEnv", () => {
  test("maps an oauth credential to the SDK env var", () => {
    expect(credentialEnv(loadConfig(base))).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" });
  });

  test("maps an api key credential to the SDK env var", () => {
    const { CLAUDE_CODE_OAUTH_TOKEN: _drop, ...noOauth } = base;
    expect(credentialEnv(loadConfig({ ...noOauth, ANTHROPIC_API_KEY: "sk-ant-xxx" }))).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-xxx",
    });
  });
});
