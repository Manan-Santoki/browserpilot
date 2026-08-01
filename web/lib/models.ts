import "server-only";
import { eq } from "drizzle-orm";
import { settings } from "@browserpilot/db";
import {
  modelCatalogue,
  parseStoredCatalogue,
  withCurrentModel,
  type ModelChoice,
} from "@browserpilot/core";
import { db } from "./db";

/**
 * The models this deployment may run.
 *
 * Stored settings first, then the environment — the same order, and for the
 * same reason, as the runtime's own resolver: an administrator switching
 * provider in the console must not leave the picker offering the old
 * provider's line-up. A console offering models the runtime's provider does not
 * serve produces a failed session and no explanation, so the two lists must not
 * be allowed to drift.
 */
export async function availableModels(): Promise<ModelChoice[]> {
  const [row] = await db()
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "providerModels"))
    .limit(1);

  const stored = parseStoredCatalogue(row?.value);
  if (stored.length > 0) return stored;

  const [baseUrlRow] = await db()
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "providerBaseUrl"))
    .limit(1);

  const gateway =
    (typeof baseUrlRow?.value === "string" && baseUrlRow.value.trim().length > 0) ||
    Boolean(process.env.BP_ANTHROPIC_BASE_URL?.trim());

  return modelCatalogue(process.env.BP_MODELS, gateway);
}

/** The catalogue for a picker that must be able to show `current`. */
export async function modelsIncluding(current: string): Promise<ModelChoice[]> {
  return withCurrentModel(await availableModels(), current);
}

export type { ModelChoice };
