import "server-only";
import { createDatabase, type Database } from "@browserpilot/db";

/**
 * One pool per *process*, not one per module instance.
 *
 * This was a plain module-level `let`, with a comment saying it existed to
 * survive Next.js hot reload. It did not: a hot reload re-evaluates the
 * module, so the variable was reinitialised to `undefined` and the next
 * request built a fresh pool while the previous one still held its
 * connections. Editing a few dozen files in one sitting was enough to walk a
 * 100-connection server up to `FATAL: sorry, too many clients already` — and
 * the symptom then landed on whatever request came next, which is why it never
 * looked like it came from the console.
 *
 * `globalThis` outlives module re-evaluation, which is what makes the cache
 * actually cache.
 */
const globalForDb = globalThis as typeof globalThis & { browserpilotDb?: Database };

export function db(): Database {
  if (!globalForDb.browserpilotDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required");
    // Bounded and short-lived: the console shares its database with the
    // runtime, and no one client should be able to exhaust the server.
    globalForDb.browserpilotDb = createDatabase(url, {
      max: 3,
      idleTimeout: 20,
      maxLifetime: 300,
    });
  }
  return globalForDb.browserpilotDb;
}
