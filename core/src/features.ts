export type FeatureEnvironment = Record<string, string | undefined>;

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

/**
 * Job mode is an internal beta. Development and test environments keep it
 * available unless explicitly disabled, while production fails closed unless
 * an operator deliberately enables it.
 */
export function isJobModeEnabled(env: FeatureEnvironment): boolean {
  const configured = env.BP_JOB_MODE_ENABLED?.trim().toLowerCase();
  if (!configured) return env.NODE_ENV !== "production";
  if (ENABLED_VALUES.has(configured)) return true;
  if (DISABLED_VALUES.has(configured)) return false;
  return false;
}
