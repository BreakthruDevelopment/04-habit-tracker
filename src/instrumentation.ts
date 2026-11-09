/**
 * Runs once when a server instance starts. With MIGRATE_ON_START=true it applies pending database migrations
 * before the server takes traffic (a Postgres advisory lock makes that safe when several instances start at once).
 * Then, without blocking startup, it waits for migrations to succeed, loads (or creates) the VAPID keys, and
 * starts the in-process reminder scheduler (REMINDER_SCHEDULER=off disables the scheduler).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { migrateOnStart, whenMigrated } = await import("./lib/db/migrate-on-start");
  if (process.env.MIGRATE_ON_START === "true") await migrateOnStart();

  void (async () => {
    const { log } = await import("./lib/log");
    try {
      await whenMigrated();
      if (!process.env.DATABASE_URL) return;
      try {
        const { getVapidKeys } = await import("./lib/vapid");
        await getVapidKeys();
      } catch (err) {
        // Reminders stay off (health says push: "off") until the next use succeeds; nothing else is affected.
        log.error("vapid.warmup_failed", { error: err instanceof Error ? err.message : String(err) });
      }
      const { startReminderScheduler } = await import("./lib/reminder-scheduler");
      startReminderScheduler();
    } catch (err) {
      log.error("instrumentation.background_failed", { error: err instanceof Error ? err.message : String(err) });
    }
  })();
}
