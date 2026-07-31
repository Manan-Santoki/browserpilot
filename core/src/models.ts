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

export type ModelChoice = {
  /** Sent to the provider as the model id. */
  value: string;
  /** Shown in the console's picker. */
  label: string;
};

/** What Anthropic's own API serves, when nothing else is configured. */
export const ANTHROPIC_MODELS: ModelChoice[] = [
  { value: "claude-opus-5", label: "Opus 5 · most capable" },
  { value: "claude-sonnet-5", label: "Sonnet 5 · faster" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5 · fastest" },
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
    models.push({ value, label: label || value });
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
  return [...models, { value, label: `${value} · not in BP_MODELS` }];
}
