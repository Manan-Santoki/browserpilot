import {
  ANTHROPIC_MODELS,
  normalizeBaseUrl,
  parseModelCatalogue,
  parseStoredCatalogue,
  type ModelChoice,
  type WireFormat,
} from "@browserpilot/core";
import { providerHeaders } from "./preflight";

// Re-exported: the runtime's own callers and tests reach for it here, next to
// the settings it validates.
export { normalizeBaseUrl };

/**
 * Which Messages API the agent talks to, and what it may run there.
 *
 * Two sources feed it, exactly as storage settings work: the environment,
 * which is how a deployment is wired up at deploy time, and the settings
 * table, which is how an administrator points it somewhere else. The database
 * wins where it says anything, so switching from a gateway back to Anthropic
 * — or between gateways — takes effect on the next session rather than
 * requiring a redeploy.
 */

/**
 * How the credential is presented. This is not cosmetic: the same key sent
 * the wrong way is a bare 401 with nothing to debug, and gateways disagree
 * about which they want. OpenCode wants `x-api-key` despite issuing a key
 * that reads like a bearer token.
 */
export type CredentialKind = "oauth" | "apiKey" | "authToken";

export type ProviderSettings = {
  /** The format requests are built in. Per-model entries may override it. */
  format: WireFormat;
  /** Absent means Anthropic's own API. */
  baseUrl?: string;
  credential: { kind: CredentialKind; value: string };
  models: ModelChoice[];
};

export type ProviderRow = { key: string; value: unknown };

/** Settings keys an administrator can write. The credential is stored sealed. */
export const PROVIDER_KEYS = [
  "providerFormat",
  "providerBaseUrl",
  "providerCredentialKind",
  "providerCredential",
  "providerModels",
] as const;

export type ProviderEnv = {
  BP_ANTHROPIC_BASE_URL?: string;
  BP_MODELS?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
};

/** Pick the provider variables out of a process environment. */
export function providerEnvVars(env: Record<string, string | undefined>): ProviderEnv {
  return {
    BP_ANTHROPIC_BASE_URL: env.BP_ANTHROPIC_BASE_URL,
    BP_MODELS: env.BP_MODELS,
    CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN: env.ANTHROPIC_AUTH_TOKEN,
  };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}


function credentialKind(value: unknown): CredentialKind | undefined {
  return value === "oauth" || value === "apiKey" || value === "authToken" ? value : undefined;
}

/**
 * Resolve the two sources into one answer.
 *
 * `unseal` is passed in rather than a key: this module should not be able to
 * decrypt anything on its own, and the caller already holds the master key.
 *
 * Returns `null` rather than throwing when nothing usable is configured. A
 * runtime with no provider should still serve its console, its files and its
 * existing sessions and say plainly that no model is reachable — the
 * alternative is a service that refuses to boot because of a setting an
 * administrator can only fix through that same service.
 */
export function resolveProviderSettings(
  rows: ProviderRow[],
  env: ProviderEnv,
  unseal: (sealed: string) => string,
): ProviderSettings | null {
  const stored = new Map(rows.map((row) => [row.key, row.value]));

  const baseUrl = normalizeBaseUrl(
    text(stored.get("providerBaseUrl")) ?? text(env.BP_ANTHROPIC_BASE_URL),
  );

  const storedFormat = stored.get("providerFormat");
  const format: WireFormat =
    storedFormat === "openai" || storedFormat === "anthropic" ? storedFormat : "anthropic";

  // A sealed credential replaces the environment entirely — a half-applied
  // change, where the key came from the database and the URL from the
  // environment, is how you end up sending one provider's key to another.
  const sealed = text(stored.get("providerCredential"));
  let credential: ProviderSettings["credential"] | undefined;

  if (sealed) {
    try {
      credential = {
        kind: credentialKind(stored.get("providerCredentialKind")) ?? "apiKey",
        value: unseal(sealed),
      };
    } catch {
      // A credential that will not unseal is a credential we do not have.
      credential = undefined;
    }
  } else {
    const authToken = text(env.ANTHROPIC_AUTH_TOKEN);
    const apiKey = text(env.ANTHROPIC_API_KEY);
    const oauth = text(env.CLAUDE_CODE_OAUTH_TOKEN);

    if (baseUrl) {
      // A subscription token authenticates to Anthropic and nowhere else, so
      // it is deliberately not a candidate once a gateway is configured.
      if (authToken) credential = { kind: "authToken", value: authToken };
      else if (apiKey) credential = { kind: "apiKey", value: apiKey };
    } else if (oauth) credential = { kind: "oauth", value: oauth };
    else if (apiKey) credential = { kind: "apiKey", value: apiKey };
    else if (authToken) credential = { kind: "authToken", value: authToken };
  }

  if (!credential) return null;

  const models = catalogueFor(stored.get("providerModels"), env.BP_MODELS, Boolean(baseUrl));
  if (models.length === 0) return null;

  return { format, baseUrl, credential, models };
}

/**
 * The catalogue, stored first and environment second.
 *
 * A gateway with no catalogue gets an empty list rather than the Claude
 * line-up: offering models it has never heard of produces a 404 per session
 * with nothing on screen to explain it.
 */
function catalogueFor(
  stored: unknown,
  raw: string | undefined,
  usesGateway: boolean,
): ModelChoice[] {
  const fromDb = parseStoredCatalogue(stored);
  if (fromDb.length > 0) return fromDb;

  const fromEnv = parseModelCatalogue(raw);
  if (fromEnv.length > 0) return fromEnv;

  return usesGateway ? [] : ANTHROPIC_MODELS;
}

/** What this provider means for one model, once per-model overrides apply. */
export function formatForModel(settings: ProviderSettings, model: string): WireFormat {
  return settings.models.find((m) => m.value === model)?.format ?? settings.format;
}

/** What the console may show about the current provider. Never the credential. */
export function describeProviderSettings(settings: ProviderSettings | null): {
  configured: boolean;
  format?: WireFormat;
  endpoint?: string;
  credentialKind?: CredentialKind;
  models?: ModelChoice[];
} {
  if (!settings) return { configured: false };
  return {
    configured: true,
    format: settings.format,
    endpoint: settings.baseUrl ?? "https://api.anthropic.com",
    credentialKind: settings.credential.kind,
    models: settings.models,
  };
}

/**
 * Everything one session's agent needs to know about its provider.
 *
 * Both engines are fed from here, so a model's format and its vision flag
 * cannot drift apart from the credential they are used with. `env` serves the
 * Agent SDK, which configures a subprocess; `headers` and `baseUrl` serve the
 * AI SDK, which builds its own client in-process.
 */
export function agentProviderOptions(
  settings: ProviderSettings,
  model: string,
): {
  format: WireFormat;
  vision: boolean;
  baseUrl?: string;
  headers: Record<string, string>;
  env: Record<string, string>;
} {
  const choice = settings.models.find((m) => m.value === model);
  const format = formatForModel(settings, model);
  return {
    format,
    // A model we have never catalogued is assumed sighted: the failure that
    // causes is one 400 on a screenshot, where assuming blind would silently
    // withhold every image from a model that could have read them.
    vision: choice?.vision ?? true,
    baseUrl: settings.baseUrl,
    headers: providerHeaders(settings.credential, format),
    env: providerSubprocessEnv(settings),
  };
}

/** The environment that points an agent subprocess at this provider. */
export function providerSubprocessEnv(settings: ProviderSettings): Record<string, string> {
  const env: Record<string, string> = {};
  if (settings.baseUrl) env.ANTHROPIC_BASE_URL = settings.baseUrl;

  switch (settings.credential.kind) {
    case "oauth":
      env.CLAUDE_CODE_OAUTH_TOKEN = settings.credential.value;
      break;
    case "apiKey":
      env.ANTHROPIC_API_KEY = settings.credential.value;
      break;
    case "authToken":
      env.ANTHROPIC_AUTH_TOKEN = settings.credential.value;
      break;
  }

  return env;
}
