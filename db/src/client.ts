import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Database = ReturnType<typeof createDatabase>;

/**
 * Both services build their own client from this factory. Drizzle over
 * postgres-js works identically under Bun (the runtime) and Node (the
 * console), with no generated client to resolve — which is what makes one
 * schema usable from both.
 */
export function createDatabase(connectionString: string, options: { max?: number } = {}) {
  const sql = postgres(connectionString, { max: options.max ?? 10 });
  return drizzle(sql, { schema });
}

export { schema };
export * from "./schema";
