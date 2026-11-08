import "server-only";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/lib/env";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;

// One pool per process. In dev, survive hot reloads by parking it on globalThis.
const globalForDb = globalThis as unknown as { sql?: postgres.Sql; db?: Db };

export function db(): Db {
  if (!globalForDb.db) {
    const sql = postgres(env().DATABASE_URL, {
      // Free-tier databases allow few connections; serverless instances must stay small.
      max: Number(process.env.DB_POOL_MAX ?? 5),
      idle_timeout: 20,
      connect_timeout: 10,
    });
    globalForDb.sql = sql;
    globalForDb.db = drizzle(sql, { schema });
  }
  return globalForDb.db;
}

/** Cheap connectivity check for the health endpoint. */
export async function pingDb(): Promise<boolean> {
  try {
    db();
    await globalForDb.sql!`select 1`;
    return true;
  } catch {
    return false;
  }
}

export { schema };
