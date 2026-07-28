/**
 * Operational policy, stored in the database so an admin can change it without
 * a redeploy. The runtime reads these; the console writes them.
 */
export type RuntimeSettings = {
  /** Browsers one person may run at once. */
  perUserSessionLimit: number;
  /** Browsers the whole server will run at once. Bounded by RAM, not by code. */
  globalSessionLimit: number;
  /** Idle time before a session is swept. */
  idleTimeoutMs: number;
  /** Absolute lifetime, however active the session is. */
  hardCapMs: number;
  defaultModel: string;
};

export const DEFAULT_SETTINGS: RuntimeSettings = {
  perUserSessionLimit: 3,
  globalSessionLimit: 8,
  idleTimeoutMs: 600_000,
  hardCapMs: 3_600_000,
  defaultModel: "claude-opus-5",
};

/** Floors that keep a mistyped setting from making the service unusable. */
const MINIMUMS = {
  perUserSessionLimit: 1,
  globalSessionLimit: 1,
  idleTimeoutMs: 30_000,
  hardCapMs: 60_000,
} as const;

export type SettingRow = { key: string; value: unknown };

export function parseSettings(rows: SettingRow[]): RuntimeSettings {
  const result: RuntimeSettings = { ...DEFAULT_SETTINGS };

  for (const row of rows) {
    if (!(row.key in DEFAULT_SETTINGS)) continue;
    const key = row.key as keyof RuntimeSettings;

    if (key === "defaultModel") {
      if (typeof row.value === "string" && row.value.trim().length > 0) {
        result.defaultModel = row.value.trim();
      }
      continue;
    }

    // A wrong type means a bad write somewhere; prefer the default over
    // letting NaN propagate into a session cap.
    if (typeof row.value !== "number" || !Number.isFinite(row.value)) continue;
    result[key] = Math.max(row.value, MINIMUMS[key]);
  }

  return result;
}
