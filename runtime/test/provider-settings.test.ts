import { describe, expect, test } from "bun:test";
import {
  describeProviderSettings,
  formatForModel,
  normalizeBaseUrl,
  providerSubprocessEnv,
  resolveProviderSettings,
  type ProviderRow,
} from "../src/agent/provider-settings";

/** Stands in for the master-key unseal the caller supplies. */
const unseal = (sealed: string) => {
  if (sealed === "corrupt") throw new Error("cannot decrypt");
  return sealed.replace(/^sealed:/, "");
};

const rows = (entries: Record<string, unknown>): ProviderRow[] =>
  Object.entries(entries).map(([key, value]) => ({ key, value }));

describe("normalizeBaseUrl", () => {
  test.each([
    ["https://opencode.ai/zen/go/v1/messages", "the documented Anthropic endpoint"],
    ["https://opencode.ai/zen/go/v1/chat/completions", "the documented OpenAI endpoint"],
    ["https://opencode.ai/zen/go/v1", "trimmed back to the version"],
    ["https://opencode.ai/zen/go/", "a trailing slash"],
  ])("trims %s — %s", (input) => {
    expect(normalizeBaseUrl(input)).toBe("https://opencode.ai/zen/go");
  });

  test("leaves a bare base alone", () => {
    expect(normalizeBaseUrl("https://opencode.ai/zen/go")).toBe("https://opencode.ai/zen/go");
  });

  test("rejects a relative URL and a non-http scheme", () => {
    expect(() => normalizeBaseUrl("opencode.ai/zen")).toThrow(/absolute/i);
    expect(() => normalizeBaseUrl("ftp://example.com")).toThrow(/http or https/i);
  });

  test("blank is simply absent", () => {
    expect(normalizeBaseUrl("   ")).toBeUndefined();
    expect(normalizeBaseUrl(undefined)).toBeUndefined();
  });
});

describe("resolveProviderSettings — environment only", () => {
  test("Anthropic with a subscription token", () => {
    const settings = resolveProviderSettings([], { CLAUDE_CODE_OAUTH_TOKEN: "tok" }, unseal);
    expect(settings?.baseUrl).toBeUndefined();
    expect(settings?.credential).toEqual({ kind: "oauth", value: "tok" });
    expect(settings?.models.map((m) => m.value)).toContain("claude-opus-5");
  });

  test("a gateway never falls back to the subscription token", () => {
    // It authenticates to Anthropic and nowhere else; sending it onward would
    // fail with someone else's opaque 401.
    const settings = resolveProviderSettings(
      [],
      {
        BP_ANTHROPIC_BASE_URL: "https://opencode.ai/zen/go",
        CLAUDE_CODE_OAUTH_TOKEN: "tok",
        BP_MODELS: "mimo-v2.5",
      },
      unseal,
    );
    expect(settings).toBeNull();
  });

  test("a gateway takes the bearer token, then the api key", () => {
    const base = { BP_ANTHROPIC_BASE_URL: "https://gw.test", BP_MODELS: "m" };
    expect(
      resolveProviderSettings([], { ...base, ANTHROPIC_AUTH_TOKEN: "a", ANTHROPIC_API_KEY: "k" }, unseal)
        ?.credential,
    ).toEqual({ kind: "authToken", value: "a" });
    expect(
      resolveProviderSettings([], { ...base, ANTHROPIC_API_KEY: "k" }, unseal)?.credential,
    ).toEqual({ kind: "apiKey", value: "k" });
  });

  test("a gateway with no catalogue is not configured", () => {
    // Offering Claude ids to a gateway that resells Qwen 404s once per session
    // with nothing on screen to explain it.
    expect(
      resolveProviderSettings(
        [],
        { BP_ANTHROPIC_BASE_URL: "https://gw.test", ANTHROPIC_API_KEY: "k" },
        unseal,
      ),
    ).toBeNull();
  });

  test("no credential at all is not configured, rather than a crash", () => {
    expect(resolveProviderSettings([], {}, unseal)).toBeNull();
  });
});

describe("resolveProviderSettings — stored settings win", () => {
  const env = {
    BP_ANTHROPIC_BASE_URL: "https://from-env.test",
    ANTHROPIC_API_KEY: "env-key",
    BP_MODELS: "env-model",
  };

  test("the database overrides every part of the environment", () => {
    const settings = resolveProviderSettings(
      rows({
        providerFormat: "openai",
        providerBaseUrl: "https://opencode.ai/zen/go/v1/messages",
        providerCredentialKind: "apiKey",
        providerCredential: "sealed:db-key",
        providerModels: [{ value: "mimo-v2.5", label: "MiMo", vision: true }],
      }),
      env,
      unseal,
    );

    expect(settings?.format).toBe("openai");
    expect(settings?.baseUrl).toBe("https://opencode.ai/zen/go");
    expect(settings?.credential).toEqual({ kind: "apiKey", value: "db-key" });
    expect(settings?.models).toEqual([{ value: "mimo-v2.5", label: "MiMo", vision: true, format: undefined }]);
  });

  test("a stored credential is never mixed with an environment one", () => {
    // Taking the key from the database and the URL from the environment is how
    // one provider's key ends up at another provider's endpoint.
    const settings = resolveProviderSettings(
      rows({ providerCredential: "sealed:db-key", providerModels: [{ value: "m" }] }),
      env,
      unseal,
    );
    expect(settings?.credential.value).toBe("db-key");
  });

  test("a credential that will not unseal is a credential we do not have", () => {
    expect(
      resolveProviderSettings(rows({ providerCredential: "corrupt" }), {}, unseal),
    ).toBeNull();
  });

  test("format defaults to anthropic when unset or nonsense", () => {
    const settings = resolveProviderSettings(
      rows({ providerFormat: "sideways", providerCredential: "sealed:k", providerModels: [{ value: "m" }] }),
      {},
      unseal,
    );
    expect(settings?.format).toBe("anthropic");
  });
});

describe("formatForModel", () => {
  const settings = resolveProviderSettings(
    rows({
      providerFormat: "openai",
      providerCredential: "sealed:k",
      providerModels: [
        { value: "mimo-v2.5", label: "MiMo", vision: true },
        { value: "claude-opus-5", label: "Opus", vision: true, format: "anthropic" },
      ],
    }),
    {},
    unseal,
  )!;

  test("uses the provider's format by default", () => {
    expect(formatForModel(settings, "mimo-v2.5")).toBe("openai");
  });

  test("a per-model override wins, so one catalogue can mix formats", () => {
    expect(formatForModel(settings, "claude-opus-5")).toBe("anthropic");
  });

  test("an unknown model falls back to the provider's format", () => {
    expect(formatForModel(settings, "who-knows")).toBe("openai");
  });
});

describe("providerSubprocessEnv", () => {
  test("each credential kind maps to the variable that sends the right header", () => {
    const base = { format: "anthropic" as const, models: [] };
    expect(providerSubprocessEnv({ ...base, credential: { kind: "oauth", value: "t" } })).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "t",
    });
    expect(providerSubprocessEnv({ ...base, credential: { kind: "apiKey", value: "k" } })).toEqual({
      ANTHROPIC_API_KEY: "k",
    });
    expect(providerSubprocessEnv({ ...base, credential: { kind: "authToken", value: "b" } })).toEqual({
      ANTHROPIC_AUTH_TOKEN: "b",
    });
  });

  test("only one credential is ever handed over", () => {
    const env = providerSubprocessEnv({
      format: "openai",
      baseUrl: "https://gw.test",
      credential: { kind: "apiKey", value: "k" },
      models: [],
    });
    expect(env).toEqual({ ANTHROPIC_BASE_URL: "https://gw.test", ANTHROPIC_API_KEY: "k" });
  });
});

describe("describeProviderSettings", () => {
  test("says plainly when nothing is configured", () => {
    expect(describeProviderSettings(null)).toEqual({ configured: false });
  });

  test("names the endpoint and never the credential", () => {
    const described = describeProviderSettings({
      format: "openai",
      baseUrl: "https://opencode.ai/zen/go",
      credential: { kind: "apiKey", value: "sk-secret-value" },
      models: [{ value: "m", label: "M", vision: false }],
    });
    expect(described.endpoint).toBe("https://opencode.ai/zen/go");
    expect(described.credentialKind).toBe("apiKey");
    expect(JSON.stringify(described)).not.toContain("sk-secret-value");
  });

  test("Anthropic is named explicitly rather than shown as blank", () => {
    expect(
      describeProviderSettings({
        format: "anthropic",
        credential: { kind: "oauth", value: "t" },
        models: [],
      }).endpoint,
    ).toBe("https://api.anthropic.com");
  });
});
