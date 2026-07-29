export type AiCredential =
  | { kind: "oauth"; value: string }
  | { kind: "apiKey"; value: string };

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
  model: string;
  nodeBin: string;
  aiCredential: AiCredential;
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

function readCredential(env: Record<string, string | undefined>): AiCredential {
  const oauth = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (oauth) return { kind: "oauth", value: oauth };
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (apiKey) return { kind: "apiKey", value: apiKey };
  throw new Error("One of CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY is required");
}

export function loadConfig(env: Record<string, string | undefined>): RuntimeConfig {
  const masterKey = required(env, "BP_MASTER_KEY");
  // Checked here rather than at first use: a key too short to seal a secret
  // should stop the process at boot, not when someone registers a site.
  if (masterKey.length < 32) {
    throw new Error("BP_MASTER_KEY must be at least 32 characters");
  }

  return {
    port: num(env, "BP_PORT", 8787),
    databaseUrl: required(env, "DATABASE_URL"),
    masterKey,
    ticketSecret: required(env, "BP_TICKET_SECRET"),
    downloadsRoot: env.BP_DOWNLOADS_DIR?.trim() || "./downloads",
    model: env.BP_MODEL?.trim() || "claude-opus-5",
    nodeBin: env.BP_NODE_BIN?.trim() || "node",
    aiCredential: readCredential(env),
  };
}

export function credentialEnv(config: RuntimeConfig): Record<string, string> {
  return config.aiCredential.kind === "oauth"
    ? { CLAUDE_CODE_OAUTH_TOKEN: config.aiCredential.value }
    : { ANTHROPIC_API_KEY: config.aiCredential.value };
}
