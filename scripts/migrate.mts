/**
 * Applies pending migrations from ./drizzle. Run as a one-off step before each
 * deploy (CI does this), never from the web server on startup, so scaled-out
 * instances can't race each other.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = postgres(url, { max: 1 });

try {
  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  console.log(JSON.stringify({ level: "info", msg: "db.migrated" }));
} finally {
  await sql.end();
}
