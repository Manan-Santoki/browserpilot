export type AiCredential =
  | { kind: "oauth"; value: string }
  | { kind: "apiKey"; value: string };

export type RuntimeConfig = {
  port: number;
  jwmUrl: string;
  sessionSecret: string;
  downloadsRoot: string;
  model: string;
  maxConcurrentSessions: number;
  idleTimeoutMs: number;
  hardCapMs: number;
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
  return {
    port: num(env, "BP_PORT", 8787),
    jwmUrl: required(env, "BP_JWM_URL").replace(/\/+$/, ""),
    sessionSecret: required(env, "SESSION_SECRET"),
    downloadsRoot: env.BP_DOWNLOADS_DIR?.trim() || "./downloads",
    model: env.BP_MODEL?.trim() || "claude-opus-5",
    maxConcurrentSessions: num(env, "BP_MAX_SESSIONS", 2),
    idleTimeoutMs: num(env, "BP_IDLE_TIMEOUT_MS", 600_000),
    hardCapMs: num(env, "BP_HARD_CAP_MS", 3_600_000),
    nodeBin: env.BP_NODE_BIN?.trim() || "node",
    aiCredential: readCredential(env),
  };
}

export function credentialEnv(config: RuntimeConfig): Record<string, string> {
  return config.aiCredential.kind === "oauth"
    ? { CLAUDE_CODE_OAUTH_TOKEN: config.aiCredential.value }
    : { ANTHROPIC_API_KEY: config.aiCredential.value };
}
