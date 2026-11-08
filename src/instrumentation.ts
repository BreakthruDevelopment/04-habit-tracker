/**
 * Runs once when a server instance starts. With MIGRATE_ON_START=true it applies
 * pending database migrations before the server takes traffic. A Postgres advisory
 * lock makes it safe when several instances start at once.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.MIGRATE_ON_START !== "true") return;
  const { migrateOnStart } = await import("./lib/db/migrate-on-start");
  await migrateOnStart();
}
