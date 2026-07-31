import { describe, expect, test } from "bun:test";
import { checkProvider, formatCheck, messagesEndpoint, providerHeaders } from "../src/agent/preflight";
import { loadConfig, type RuntimeConfig } from "../src/config";

const base = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/browserpilot",
  BP_MASTER_KEY: "m".repeat(44),
  BP_TICKET_SECRET: "t".repeat(44),
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
};

const gateway = {
  ...base,
  CLAUDE_CODE_OAUTH_TOKEN: undefined,
  BP_ANTHROPIC_BASE_URL: "https://opencode.ai/zen/go",
  ANTHROPIC_AUTH_TOKEN: "sk-gateway",
  BP_MODELS: "qwen3.7-plus",
} as Record<string, string | undefined>;

/**
 * A provider that answers however the test tells it to, and records the call.
 *
 * `reply` is a factory rather than a Response: a Response body can only be
 * read once, so a shared instance fails the second time the stub is called.
 */
function stubProvider(reply: () => Response | Promise<never>) {
  const calls: Array<{ url: string; headers: Headers; body: unknown }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    return reply();
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const ok = () => new Response(JSON.stringify({ id: "msg_1" }), { status: 200 });
const status = (code: number, body = "") => () => new Response(body, { status: code });

describe("messagesEndpoint", () => {
  test("defaults to Anthropic", () => {
    expect(messagesEndpoint(loadConfig(base))).toBe("https://api.anthropic.com/v1/messages");
  });

  test("appends the path the SDK would append", () => {
    expect(messagesEndpoint(loadConfig(gateway))).toBe("https://opencode.ai/zen/go/v1/messages");
  });
});

describe("providerHeaders", () => {
  test("an API key rides x-api-key", () => {
    expect(providerHeaders({ kind: "apiKey", value: "sk-ant" })).toEqual({ "x-api-key": "sk-ant" });
  });

  test("a subscription token rides Authorization, with the OAuth beta header", () => {
    expect(providerHeaders({ kind: "oauth", value: "tok" })).toEqual({
      authorization: "Bearer tok",
      "anthropic-beta": "oauth-2025-04-20",
    });
  });

  test("a gateway token rides Authorization without Anthropic's beta header", () => {
    // A gateway neither wants nor understands it.
    expect(providerHeaders({ kind: "authToken", value: "sk-x" })).toEqual({
      authorization: "Bearer sk-x",
    });
  });
});

describe("checkProvider", () => {
  test("sends the smallest request that still exercises auth and routing", async () => {
    const { fetchFn, calls } = stubProvider(ok);
    const check = await checkProvider(loadConfig(gateway), "qwen3.7-plus", { fetchFn });

    expect(check.ok).toBe(true);
    expect(calls[0]!.url).toBe("https://opencode.ai/zen/go/v1/messages");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer sk-gateway");
    expect(calls[0]!.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(calls[0]!.body).toMatchObject({ model: "qwen3.7-plus", max_tokens: 1 });
  });

  test("checks the configured default model when none is named", async () => {
    const { fetchFn, calls } = stubProvider(ok);
    await checkProvider(loadConfig(gateway), undefined, { fetchFn });
    expect(calls[0]!.body).toMatchObject({ model: "qwen3.7-plus" });
  });

  test("a 401 names the header used and the one to try instead", async () => {
    // Gateways disagree about which header they want, and a bare "401" gives
    // no hint. OpenCode wants x-api-key despite issuing an `sk-` key that
    // reads like a bearer token — this is the one-line fix for that.
    const { fetchFn } = stubProvider(status(401, "no"));
    const bearer = await checkProvider(loadConfig(gateway), undefined, { fetchFn });

    if (bearer.ok) throw new Error("expected a failure");
    expect(bearer.status).toBe(401);
    expect(bearer.detail).toMatch(/credential rejected/i);
    expect(bearer.detail).toContain("Authorization: Bearer");
    expect(bearer.detail).toContain("ANTHROPIC_API_KEY");

    // ...and the mirror image, so neither direction is a dead end.
    const { ANTHROPIC_AUTH_TOKEN: _drop, ...asApiKey } = gateway;
    const keyed = await checkProvider(
      loadConfig({ ...asApiKey, ANTHROPIC_API_KEY: "sk-x" }),
      undefined,
      { fetchFn },
    );

    if (keyed.ok) throw new Error("expected a failure");
    expect(keyed.detail).toContain("x-api-key");
    expect(keyed.detail).toContain("ANTHROPIC_AUTH_TOKEN");
  });

  test("a 404 points at the base URL and the model id", async () => {
    const { fetchFn } = stubProvider(status(404, "nope"));
    const check = await checkProvider(loadConfig(gateway), undefined, { fetchFn });

    if (check.ok) throw new Error("expected a failure");
    expect(check.detail).toMatch(/BP_ANTHROPIC_BASE_URL/);
  });

  test("a 400 is read as an unknown model", async () => {
    const { fetchFn } = stubProvider(status(400, JSON.stringify({ error: { message: "model: unknown" } })));
    const check = await checkProvider(loadConfig(gateway), "not-a-model", { fetchFn });

    if (check.ok) throw new Error("expected a failure");
    expect(check.detail).toMatch(/unknown model id/i);
    expect(check.detail).toContain("model: unknown");
  });

  test("a 429 passes — it can only come from a provider that understood us", async () => {
    // Failing here would gate a deploy on a busy account rather than a broken
    // one: a quota error proves both the route and the credential.
    const { fetchFn } = stubProvider(status(429, "slow down"));
    const check = await checkProvider(loadConfig(gateway), undefined, { fetchFn });

    if (!check.ok) throw new Error("a rate limit is not a misconfiguration");
    expect(check.rateLimited).toBe(true);
    expect(formatCheck(check)).toMatch(/rate limited/i);
    expect(formatCheck(check)).not.toContain("UNREACHABLE");
  });

  test("an unreachable provider is a failure, not a thrown error", async () => {
    // Boot must survive it — the rest of the service is fine.
    const { fetchFn } = stubProvider(() => Promise.reject(new Error("ECONNREFUSED")));
    const check = await checkProvider(loadConfig(gateway), undefined, { fetchFn });

    if (check.ok) throw new Error("expected a failure");
    expect(check.status).toBeUndefined();
    expect(check.detail).toMatch(/could not reach the provider/i);
  });

  test("a long error body is truncated rather than flooding the log", async () => {
    const { fetchFn } = stubProvider(status(500, "x".repeat(5000)));
    const check = await checkProvider(loadConfig(gateway), undefined, { fetchFn });

    if (check.ok) throw new Error("expected a failure");
    expect(check.detail.length).toBeLessThan(400);
  });
});

describe("formatCheck", () => {
  test("a success names the model and where it answered", () => {
    const line = formatCheck({
      ok: true,
      endpoint: "https://opencode.ai/zen/go/v1/messages",
      model: "qwen3.7-plus",
      latencyMs: 120,
    });
    expect(line).toContain("provider ok");
    expect(line).toContain("qwen3.7-plus");
  });

  test("a failure is loud enough to find in a container log", () => {
    const line = formatCheck({
      ok: false,
      endpoint: "https://opencode.ai/zen/go/v1/messages",
      model: "qwen3.7-plus",
      status: 401,
      detail: "credential rejected",
    });
    expect(line).toContain("UNREACHABLE");
    expect(line).toContain("HTTP 401");
  });

  test("never prints the credential", () => {
    const config: RuntimeConfig = loadConfig(gateway);
    expect(formatCheck({ ok: true, endpoint: messagesEndpoint(config), model: "m", latencyMs: 1 }))
      .not.toContain("sk-gateway");
  });
});
