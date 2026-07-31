import { modelCatalogue, type ModelChoice } from "@browserpilot/core";

/**
 * How the agent authenticates to whichever Messages API it is pointed at.
 *
 * The three are not interchangeable — each maps to a different header, and a
 * token presented the wrong way fails as a bare 401 with nothing to debug.
 */
export type AiCredential =
  /** `claude setup-token`; bills a Claude subscription. `Authorization: Bearer`. */
  | { kind: "oauth"; value: string }
  /** An Anthropic API key. `x-api-key`. */
  | { kind: "apiKey"; value: string }
  /** A gateway's key. `Authorization: Bearer`, no Anthropic beta header. */
  | { kind: "authToken"; value: string };

export type AiProvider = {
  /**
   * The base the SDK appends `/v1/messages` to. Absent means Anthropic's own
   * API; set it to route the agent through an Anthropic-compatible gateway.
   */
  baseUrl?: string;
  credential: AiCredential;
  /** What this provider serves — the console offers exactly these. */
  models: ModelChoice[];
};

/**
 * Bootstrap configuration only.
 *
 * Target sites, session caps, and timeouts are database rows edited in the
 * console — they are deliberately absent here. What remains is the set of
 * values needed before any row can be read, plus process-level plumbing.
 */
export type RuntimeConfig = {
  port: number;
  databaseUrl: string;
  masterKey: string;
  ticketSecret: string;
  downloadsRoot: string;
  /** Saved browser profiles for sites people sign in to themselves. */
  profilesRoot: string;
  /** Disposable per-session copies of those profiles. */
  scratchRoot: string;
  /** Used when the database has no `defaultModel` row of its own. */
  defaultModel: string;
  nodeBin: string;
  provider: AiProvider;
};

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function num(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${key} must be a number`);
  return parsed;
}

/**
 * The base URL, trimmed to what the SDK actually wants.
 *
 * Gateways document their endpoint *including* `/v1/messages`, so that is the
 * natural thing to paste in — and it yields `/v1/messages/v1/messages` and a
 * 404 nobody reads twice. Trim the suffix back off rather than making whoever
 * configured it guess which half we meant.
 */
function normalizeBaseUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim().replace(/\/+$/, "");
  if (!trimmed) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      "BP_ANTHROPIC_BASE_URL must be an absolute URL, e.g. https://opencode.ai/zen/go",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("BP_ANTHROPIC_BASE_URL must be http or https");
  }

  return trimmed.replace(/\/v1(\/messages)?$/, "");
}

function readCredential(
  env: Record<string, string | undefined>,
  usesGateway: boolean,
): AiCredential {
  const authToken = env.ANTHROPIC_AUTH_TOKEN?.trim();
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  const oauth = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();

  if (usesGateway) {
    if (authToken) return { kind: "authToken", value: authToken };
    if (apiKey) return { kind: "apiKey", value: apiKey };
    // A subscription token authenticates to Anthropic and nowhere else. Left
    // to run, every session would fail on its first model call with an opaque
    // 401 from someone else's server.
    throw new Error(
      oauth
        ? "BP_ANTHROPIC_BASE_URL is set, but the only credential is CLAUDE_CODE_OAUTH_TOKEN — a Claude subscription token is not accepted by a gateway. Set ANTHROPIC_AUTH_TOKEN to the gateway's own key."
        : "BP_ANTHROPIC_BASE_URL is set, so ANTHROPIC_AUTH_TOKEN (or ANTHROPIC_API_KEY) is required",
    );
  }

  if (oauth) return { kind: "oauth", value: oauth };
  if (apiKey) return { kind: "apiKey", value: apiKey };
  if (authToken) return { kind: "authToken", value: authToken };
  throw new Error("One of CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY is required");
}

function readProvider(env: Record<string, string | undefined>): AiProvider {
  const baseUrl = normalizeBaseUrl(env.BP_ANTHROPIC_BASE_URL);
  const models = modelCatalogue(env.BP_MODELS, Boolean(baseUrl));

  // Offering the Claude line-up against a gateway that resells Qwen would 404
  // once per session, and the console would give no hint why.
  if (baseUrl && models.length === 0) {
    throw new Error(
      "BP_ANTHROPIC_BASE_URL is set, so BP_MODELS must list what that gateway serves — the Claude model ids are not valid there",
    );
  }

  return { baseUrl, credential: readCredential(env, Boolean(baseUrl)), models };
}

export function loadConfig(env: Record<string, string | undefined>): RuntimeConfig {
  const masterKey = required(env, "BP_MASTER_KEY");
  // Checked here rather than at first use: a key too short to seal a secret
  // should stop the process at boot, not when someone registers a site.
  if (masterKey.length < 32) {
    throw new Error("BP_MASTER_KEY must be at least 32 characters");
  }

  const provider = readProvider(env);

  return {
    port: num(env, "BP_PORT", 8787),
    databaseUrl: required(env, "DATABASE_URL"),
    masterKey,
    ticketSecret: required(env, "BP_TICKET_SECRET"),
    downloadsRoot: env.BP_DOWNLOADS_DIR?.trim() || "./downloads",
    profilesRoot: env.BP_PROFILES_DIR?.trim() || "./.data/profiles",
    scratchRoot: env.BP_SCRATCH_DIR?.trim() || "./.data/scratch",
    // The head of the catalogue rather than a Claude id, so a gateway
    // deployment does not need a second variable to be usable.
    defaultModel: env.BP_MODEL?.trim() || provider.models[0]?.value || "claude-opus-5",
    nodeBin: env.BP_NODE_BIN?.trim() || "node",
    provider,
  };
}

/** The environment that points the agent subprocess at this provider. */
export function providerEnv(config: RuntimeConfig): Record<string, string> {
  const { baseUrl, credential } = config.provider;
  const env: Record<string, string> = {};

  if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;

  switch (credential.kind) {
    case "oauth":
      env.CLAUDE_CODE_OAUTH_TOKEN = credential.value;
      break;
    case "apiKey":
      env.ANTHROPIC_API_KEY = credential.value;
      break;
    case "authToken":
      env.ANTHROPIC_AUTH_TOKEN = credential.value;
      break;
  }

  return env;
}

/** One line describing where the agent's tokens are going. Logged at boot. */
export function describeProvider(config: RuntimeConfig): string {
  const { baseUrl, credential, models } = config.provider;
  const where = baseUrl ?? "api.anthropic.com";
  return `${where} · ${credential.kind} · ${models.length} model(s) · default ${config.defaultModel}`;
}
