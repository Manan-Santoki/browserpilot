import { describe, expect, test } from "bun:test";
import { describeProvider, loadConfig } from "../src/config";

const base = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/browserpilot",
  BP_MASTER_KEY: "m".repeat(44),
  BP_TICKET_SECRET: "t".repeat(44),
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
};

/** The same deployment, routed through an Anthropic-compatible gateway. */
const gateway = {
  ...base,
  CLAUDE_CODE_OAUTH_TOKEN: undefined,
  BP_ANTHROPIC_BASE_URL: "https://opencode.ai/zen/go",
  ANTHROPIC_AUTH_TOKEN: "sk-gateway",
  BP_MODELS: "qwen3.7-plus=Qwen 3.7 Plus, minimax-m3",
} as Record<string, string | undefined>;

describe("loadConfig", () => {
  test("applies defaults", () => {
    const cfg = loadConfig(base);
    expect(cfg.port).toBe(8787);
    expect(cfg.defaultModel).toBe("claude-opus-5");
    expect(cfg.nodeBin).toBe("node");
    expect(cfg.downloadsRoot).toBe("./downloads");
    expect(cfg.provider.credential).toEqual({ kind: "oauth", value: "oauth-token" });
    expect(cfg.provider.baseUrl).toBeUndefined();
  });

  test("offers the Claude family when pointed at Anthropic", () => {
    expect(loadConfig(base).provider.models.map((m) => m.value)).toEqual([
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]);
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
    expect(loadConfig({ ...base, ANTHROPIC_API_KEY: "sk-ant-xxx" }).provider.credential.kind).toBe(
      "oauth",
    );
  });

  test("falls back to the API key", () => {
    const { CLAUDE_CODE_OAUTH_TOKEN: _drop, ...noOauth } = base;
    expect(loadConfig({ ...noOauth, ANTHROPIC_API_KEY: "sk-ant-xxx" }).provider.credential).toEqual({
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

describe("gateway providers", () => {
  test("routes through the configured base URL", () => {
    const cfg = loadConfig(gateway);
    expect(cfg.provider.baseUrl).toBe("https://opencode.ai/zen/go");
    expect(cfg.provider.credential).toEqual({ kind: "authToken", value: "sk-gateway" });
  });

  test("serves the configured catalogue, not Claude", () => {
    const cfg = loadConfig(gateway);
    expect(cfg.provider.models).toEqual([
      { value: "qwen3.7-plus", label: "Qwen 3.7 Plus", vision: true },
      { value: "minimax-m3", label: "minimax-m3", vision: true },
    ]);
  });

  test("the default model follows the catalogue rather than naming a Claude id", () => {
    expect(loadConfig(gateway).defaultModel).toBe("qwen3.7-plus");
  });

  test("BP_MODEL still wins when set explicitly", () => {
    expect(loadConfig({ ...gateway, BP_MODEL: "minimax-m3" }).defaultModel).toBe("minimax-m3");
  });

  test.each([
    ["https://opencode.ai/zen/go/v1/messages", "the documented endpoint, suffix and all"],
    ["https://opencode.ai/zen/go/v1", "trimmed back to the version"],
    ["https://opencode.ai/zen/go/", "a trailing slash"],
  ])("normalizes %s — %s", (input) => {
    // The SDK appends /v1/messages itself; pasting the documented endpoint
    // would otherwise produce /v1/messages/v1/messages and a bare 404.
    expect(loadConfig({ ...gateway, BP_ANTHROPIC_BASE_URL: input }).provider.baseUrl).toBe(
      "https://opencode.ai/zen/go",
    );
  });

  test("rejects a base URL that is not absolute", () => {
    expect(() => loadConfig({ ...gateway, BP_ANTHROPIC_BASE_URL: "opencode.ai/zen/go" })).toThrow(
      /absolute URL/i,
    );
  });

  test("rejects a non-http scheme", () => {
    expect(() => loadConfig({ ...gateway, BP_ANTHROPIC_BASE_URL: "ftp://example.com" })).toThrow(
      /http or https/i,
    );
  });

  test("refuses a subscription token against a gateway", () => {
    // It authenticates to Anthropic and nowhere else, so every session would
    // fail on its first model call with someone else's opaque 401.
    const { ANTHROPIC_AUTH_TOKEN: _drop, ...noToken } = gateway;
    expect(() => loadConfig({ ...noToken, CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" })).toThrow(
      /subscription token is not accepted by a gateway/i,
    );
  });

  test("requires a credential of some kind", () => {
    const { ANTHROPIC_AUTH_TOKEN: _drop, ...noToken } = gateway;
    expect(() => loadConfig(noToken)).toThrow(/ANTHROPIC_AUTH_TOKEN/);
  });

  test("accepts an API key when that is what the gateway wants", () => {
    const { ANTHROPIC_AUTH_TOKEN: _drop, ...noToken } = gateway;
    expect(loadConfig({ ...noToken, ANTHROPIC_API_KEY: "sk-x" }).provider.credential).toEqual({
      kind: "apiKey",
      value: "sk-x",
    });
  });

  test("refuses to start without a catalogue", () => {
    // Offering the Claude line-up here would 404 once per session, with
    // nothing in the console to explain it.
    const { BP_MODELS: _drop, ...noModels } = gateway;
    expect(() => loadConfig(noModels)).toThrow(/BP_MODELS/);
  });
});

describe("describeProvider", () => {
  test("names Anthropic when no gateway is configured", () => {
    expect(describeProvider(loadConfig(base))).toContain("api.anthropic.com");
  });

  test("names the gateway and never prints the token", () => {
    const line = describeProvider(loadConfig(gateway));
    expect(line).toContain("https://opencode.ai/zen/go");
    expect(line).not.toContain("sk-gateway");
  });
});
