/**
 * Which models this deployment may run, shared by the runtime and the console.
 *
 * The list has to be configuration rather than a constant because it is a
 * property of whichever Messages API the agent is pointed at. Against
 * Anthropic the answer is the Claude family; against a gateway it is whatever
 * that gateway resells, and offering Claude models there produces a 404 per
 * session with nothing on screen to explain it.
 *
 * Both services read the same variable rather than the console asking the
 * runtime, for the same reason both are given `BP_TICKET_SECRET`: it is one
 * value describing one deployment, and a round trip would not make it truer.
 */

/** Which wire format a model is served over. Decides how we assemble requests. */
export type WireFormat = "anthropic" | "openai";

export type ModelChoice = {
  /** Sent to the provider as the model id. */
  value: string;
  /** Shown in the console's picker. */
  label: string;
  /**
   * Whether this model can read an image we send it.
   *
   * A property of the model, not the provider — on one OpenCode key,
   * mimo-v2.5 describes a screenshot accurately while deepseek-v4-flash
   * rejects the request outright. The agent reads pages through the
   * accessibility tree, so a blind model still works; it just cannot answer
   * "show me", and the console should say so rather than let someone find out
   * mid-task.
   */
  vision: boolean;
  /**
   * The wire format this model speaks. Absent means the provider's default —
   * a catalogue rarely mixes formats, but one served through a gateway can.
   */
  format?: WireFormat;
};

/** What Anthropic's own API serves, when nothing else is configured. */
export const ANTHROPIC_MODELS: ModelChoice[] = [
  { value: "claude-opus-5", label: "Opus 5 · most capable", vision: true, format: "anthropic" },
  { value: "claude-sonnet-5", label: "Sonnet 5 · faster", vision: true, format: "anthropic" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5 · fastest", vision: true, format: "anthropic" },
];

/**
 * Models we have measured, offered as one-click presets in the console.
 *
 * Every flag here was established by running the model, not read from a
 * datasheet: each one was asked to call a tool and to describe a screenshot,
 * and the vision answers were checked against the actual pixels. That matters
 * because the failure it prevents is silent — a blind model given a screenshot
 * either 400s or, worse, invents a plausible description of a page it cannot
 * see.
 *
 * It is a convenience, not a restriction. Any id can be typed in by hand; a
 * gateway's line-up changes faster than this list will.
 */
export const KNOWN_MODELS: ModelChoice[] = [
  ...ANTHROPIC_MODELS,
  { value: "minimax-m3", label: "MiniMax M3", vision: true, format: "anthropic" },
  { value: "qwen3.7-plus", label: "Qwen 3.7 Plus", vision: false, format: "anthropic" },
  { value: "mimo-v2.5", label: "MiMo V2.5", vision: true, format: "openai" },
  { value: "grok-4.5", label: "Grok 4.5", vision: true, format: "openai" },
  { value: "kimi-k3", label: "Kimi K3", vision: true, format: "openai" },
  { value: "kimi-k2.7-code", label: "Kimi K2.7 Code", vision: true, format: "openai" },
  { value: "glm-5.2", label: "GLM 5.2", vision: false, format: "openai" },
  { value: "gpt-5.6-luna", label: "GPT-5.6 Luna", vision: false, format: "openai" },
  { value: "deepseek-v4-flash", label: "DeepSeek V4 Flash", vision: false, format: "openai" },
];

/**
 * Read a catalogue from `BP_MODELS`.
 *
 * Entries are comma-separated and either a bare model id or `id=Label`. A bare
 * id is shown as itself — gateway model ids are already the name people use.
 *
 *   BP_MODELS="qwen3.7-plus=Qwen 3.7 Plus, minimax-m3=MiniMax M3"
 *
 * Returns an empty list when unset or blank, so callers can tell "not
 * configured" from "configured as empty" and decide what that means for them.
 *
 * Entries parsed from here are assumed sighted. The variable has no room to
 * say otherwise, and this is the bootstrap path — the stored catalogue an
 * administrator edits is where per-model capability is actually recorded.
 */
export function parseModelCatalogue(raw: string | undefined): ModelChoice[] {
  if (!raw?.trim()) return [];

  const seen = new Set<string>();
  const models: ModelChoice[] = [];

  for (const entry of raw.split(",")) {
    const text = entry.trim();
    if (!text) continue;

    // Only the first `=` separates id from label: a label may contain one.
    const split = text.indexOf("=");
    const value = (split === -1 ? text : text.slice(0, split)).trim();
    const label = split === -1 ? value : text.slice(split + 1).trim();
    if (!value || seen.has(value)) continue;

    seen.add(value);
    models.push({ value, label: label || value, vision: true });
  }

  return models;
}

/**
 * Read the catalogue an administrator saved, which unlike the environment has
 * room to record what each model can actually do.
 *
 * Tolerant on purpose: this is stored JSON, and one malformed entry written by
 * an older version of the form should cost that entry, not the whole list.
 */
export function parseStoredCatalogue(value: unknown): ModelChoice[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const models: ModelChoice[] = [];

  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;

    const id = typeof row.value === "string" ? row.value.trim() : "";
    if (!id || seen.has(id)) continue;

    const label = typeof row.label === "string" && row.label.trim() ? row.label.trim() : id;
    const format = row.format === "anthropic" || row.format === "openai" ? row.format : undefined;

    seen.add(id);
    // Absent means sighted, matching the environment path — an older stored
    // catalogue predates the flag and its models were all Claude.
    models.push({ value: id, label, vision: row.vision !== false, format });
  }

  return models;
}

/**
 * The catalogue to offer, given what is configured.
 *
 * A gateway with no catalogue is a misconfiguration the caller should have
 * rejected already; this returns an empty list rather than inventing Claude
 * models the gateway has never heard of.
 */
export function modelCatalogue(raw: string | undefined, usesGateway: boolean): ModelChoice[] {
  const configured = parseModelCatalogue(raw);
  if (configured.length > 0) return configured;
  return usesGateway ? [] : ANTHROPIC_MODELS;
}

/**
 * The catalogue with `current` guaranteed present.
 *
 * A stored default that has since been dropped from `BP_MODELS` would
 * otherwise vanish from the picker and be silently rewritten to whatever sits
 * at the top of the list the next time an admin saved the form.
 */
export function withCurrentModel(models: ModelChoice[], current: string): ModelChoice[] {
  const value = current.trim();
  if (!value || models.some((model) => model.value === value)) return models;
  return [...models, { value, label: `${value} · not in the catalogue`, vision: true }];
}

/** The model to run, given everything that might have an opinion. */
export function resolveModel(options: {
  /** Chosen for this one session. */
  requested?: string | null;
  /** The person's saved preference. */
  preferred?: string | null;
  /** The deployment default an administrator set. */
  fallback?: string | null;
  catalogue: ModelChoice[];
}): string | undefined {
  const known = new Set(options.catalogue.map((model) => model.value));
  // A stale preference must not outrank a deliberate per-session choice, and
  // neither should survive being dropped from the catalogue.
  for (const candidate of [options.requested, options.preferred, options.fallback]) {
    const value = candidate?.trim();
    if (value && known.has(value)) return value;
  }
  return options.fallback?.trim() || options.catalogue[0]?.value;
}
