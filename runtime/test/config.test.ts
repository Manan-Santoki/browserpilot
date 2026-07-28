import { describe, expect, test } from "bun:test";
import { credentialEnv, loadConfig } from "../src/config";

const base = {
  BP_JWM_URL: "https://jwm.example.com",
  SESSION_SECRET: "s3cret-value",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
};

describe("loadConfig", () => {
  test("applies defaults", () => {
    const cfg = loadConfig(base);
    expect(cfg.port).toBe(8787);
    expect(cfg.jwmUrl).toBe("https://jwm.example.com");
    expect(cfg.maxConcurrentSessions).toBe(2);
    expect(cfg.idleTimeoutMs).toBe(600_000);
    expect(cfg.hardCapMs).toBe(3_600_000);
    expect(cfg.model).toBe("claude-opus-5");
    expect(cfg.aiCredential).toEqual({ kind: "oauth", value: "oauth-token" });
  });

  test("strips a trailing slash from jwmUrl", () => {
    expect(loadConfig({ ...base, BP_JWM_URL: "https://jwm.example.com/" }).jwmUrl).toBe(
      "https://jwm.example.com",
    );
  });

  test("prefers the OAuth token when both credentials are set", () => {
    const cfg = loadConfig({ ...base, ANTHROPIC_API_KEY: "sk-ant-xxx" });
    expect(cfg.aiCredential.kind).toBe("oauth");
  });

  test("falls back to the API key", () => {
    const { CLAUDE_CODE_OAUTH_TOKEN: _drop, ...noOauth } = base;
    const cfg = loadConfig({ ...noOauth, ANTHROPIC_API_KEY: "sk-ant-xxx" });
    expect(cfg.aiCredential).toEqual({ kind: "apiKey", value: "sk-ant-xxx" });
  });

  test("throws when no AI credential is set", () => {
    const { CLAUDE_CODE_OAUTH_TOKEN: _drop, ...noCred } = base;
    expect(() => loadConfig(noCred)).toThrow(/CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY/);
  });

  test("throws when SESSION_SECRET is missing", () => {
    const { SESSION_SECRET: _drop, ...noSecret } = base;
    expect(() => loadConfig(noSecret)).toThrow(/SESSION_SECRET/);
  });

  test("throws when BP_JWM_URL is missing", () => {
    const { BP_JWM_URL: _drop, ...noUrl } = base;
    expect(() => loadConfig(noUrl)).toThrow(/BP_JWM_URL/);
  });

  test("numeric overrides are parsed", () => {
    const cfg = loadConfig({ ...base, BP_PORT: "9000", BP_MAX_SESSIONS: "5" });
    expect(cfg.port).toBe(9000);
    expect(cfg.maxConcurrentSessions).toBe(5);
  });
});

describe("credentialEnv", () => {
  test("maps an oauth credential to the SDK env var", () => {
    expect(credentialEnv(loadConfig(base))).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
    });
  });

  test("maps an api key credential to the SDK env var", () => {
    const { CLAUDE_CODE_OAUTH_TOKEN: _drop, ...noOauth } = base;
    expect(credentialEnv(loadConfig({ ...noOauth, ANTHROPIC_API_KEY: "sk-ant-xxx" }))).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-xxx",
    });
  });
});
