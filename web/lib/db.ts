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
    cached = createDatabase(url);
  }
  return cached;
}
