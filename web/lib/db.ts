import "server-only";
import { createDatabase, type Database } from "@browserpilot/db";

let cached: Database | undefined;

/**
 * One pool per process. Next.js re-evaluates modules on hot reload in
 * development, so without caching this would leak a connection pool on every
 * edit until Postgres refused new connections.
 */
export function db(): Database {
  if (!cached) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required");
    // Bounded and short-lived: the console shares its database with the
    // runtime and a production deployment, and a leaked pool must not be able
    // to exhaust the server's connection limit.
    cached = createDatabase(url, { max: 3, idleTimeout: 20, maxLifetime: 300 });
  }
  return cached;
}
