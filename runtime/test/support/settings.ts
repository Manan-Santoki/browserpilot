import type { Store } from "../../src/store";
import { DEFAULT_SETTINGS, type RuntimeSettings } from "../../src/settings";

/**
 * A Store whose policy comes from the test rather than from the database.
 *
 * The suite runs against the same Postgres as the live console, so the
 * settings row is whatever an admin last saved there — raising the per-user
 * limit in the UI should not decide what these tests assert. Every other query
 * still goes to the real database; only `settings()` is answered locally.
 *
 * The global limit defaults to something unreachable because that counter spans
 * every session in the database, including ones the deployed service is running
 * while the tests execute.
 */
export function withTestSettings(store: Store, overrides: Partial<RuntimeSettings> = {}): Store {
  const settings: RuntimeSettings = {
    ...DEFAULT_SETTINGS,
    globalSessionLimit: 1_000,
    ...overrides,
  };

  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "settings") return async () => ({ ...settings });
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
