import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Database = ReturnType<typeof createDatabase>;

export type DatabaseOptions = {
  /** Max connections this client may hold at once. Default 10. */
  max?: number;
  /** Seconds an idle connection may live before it is closed. Default 30. */
  idleTimeout?: number;
  /** Seconds a connection may live before it is recycled. Default 3600. */
  maxLifetime?: number;
};

/**
 * Both services build their own client from this factory. Drizzle over
 * postgres-js works identically under Bun (the runtime) and Node (the
 * console), with no generated client to resolve — which is what makes one
 * schema usable from both.
 */
export function createDatabase(
  connectionString: string,
  options: DatabaseOptions = {},
) {
  const sql = postgres(connectionString, {
    max: options.max ?? 10,
    idle_timeout: options.idleTimeout ?? 30,
    max_lifetime: options.maxLifetime ?? 3600,
  });
  return drizzle(sql, { schema });
}

export { schema };
export * from "./schema";
