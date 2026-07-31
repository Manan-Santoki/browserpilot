import "server-only";
import { modelCatalogue, withCurrentModel, type ModelChoice } from "@browserpilot/core";

/**
 * The models this deployment may run.
 *
 * Read from the same `BP_MODELS` the runtime reads, rather than asked for over
 * the wire: it is one value describing one deployment, exactly like the ticket
 * secret both services are already given. A console offering models the
 * runtime's provider does not serve produces a failed session and no
 * explanation, so the two lists must not be allowed to drift.
 */
export function availableModels(): ModelChoice[] {
  return modelCatalogue(process.env.BP_MODELS, Boolean(process.env.BP_ANTHROPIC_BASE_URL?.trim()));
}

/** The catalogue for a picker that must be able to show `current`. */
export function modelsIncluding(current: string): ModelChoice[] {
  return withCurrentModel(availableModels(), current);
}

export type { ModelChoice };
