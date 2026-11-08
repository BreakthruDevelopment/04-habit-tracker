import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { log } from "@/lib/log";

// Any constant works; it only has to be the same for every instance of this app.
const LOCK_ID = 7_301_330;

/** Delays between attempts after a failure: covers a database that is still being created (about 1 to 2 minutes). */
export const RETRY_DELAYS_MS = [5_000, 10_000, 15_000, 30_000, 30_000, 60_000, 60_000, 60_000, 120_000, 120_000];

export type MigrationState = "skipped" | "running" | "ok" | "retrying";

// Instrumentation and route handlers can load separate copies of this module, so the state lives on globalThis.
const KEY = Symbol.for("30apps.migrationState");
type Holder = { [KEY]?: MigrationState };

export function migrationState(): MigrationState | undefined {
  return (globalThis as Holder)[KEY];
}

function setState(state: MigrationState) {
  (globalThis as Holder)[KEY] = state;
}

type Deps = {
  runOnce?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  delays?: number[];
};

async function runMigrations(url: string): Promise<void> {
  const folder = process.env.MIGRATIONS_DIR ?? path.join(process.cwd(), "drizzle");
  const sql = postgres(url, { max: 1, connect_timeout: 10 });
  try {
    // Don't wait forever on a lock held by a dead instance's session: time out and let the retry loop try again.
    await sql`set lock_timeout = '30s'`;
    await sql`select pg_advisory_lock(${LOCK_ID})`;
    await sql`reset lock_timeout`;
    try {
      await migrate(drizzle(sql), { migrationsFolder: folder });
    } finally {
      await sql`select pg_advisory_unlock(${LOCK_ID})`;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Applies pending migrations. The first attempt runs before the server takes traffic. If it fails (for example a
 * brand-new app whose database the cloud is still creating), later attempts run in the background with backoff,
 * and /api/health answers 503 until one succeeds, so the Build Tracker sees the app as degraded. (No cloud probes
 * /api/health, so the platform keeps routing traffic meanwhile.) Retries never stop: after the backoff list runs out
 * they continue at its last delay, so an instance recovers whenever the database comes back.
 */
export async function migrateOnStart(deps: Deps = {}): Promise<void> {
  const current = migrationState();
  if (current === "running" || current === "retrying") return;
  const url = process.env.DATABASE_URL;
  if (!url && !deps.runOnce) {
    log.warn("db.migrate.skipped", { reason: "DATABASE_URL not set" });
    setState("skipped");
    return;
  }
  const runOnce = deps.runOnce ?? (() => runMigrations(url as string));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
  const delays = deps.delays ?? RETRY_DELAYS_MS;

  const attempt = async (n: number): Promise<boolean> => {
    const started = Date.now();
    try {
      await runOnce();
      log.info("db.migrated", { ms: Date.now() - started, attempt: n });
      setState("ok");
      return true;
    } catch (err) {
      log.error("db.migrate.failed", { error: err instanceof Error ? err.message : String(err), attempt: n });
      return false;
    }
  };

  setState("running");
  if (await attempt(1)) return;
  setState("retrying");
  // Don't block startup: health reports the state while retries run.
  void (async () => {
    for (let i = 0; ; i++) {
      await sleep(delays[Math.min(i, delays.length - 1)]);
      if (await attempt(i + 2)) return;
      if (i === delays.length - 1) log.error("db.migrate.still_failing", { attempts: i + 2 }); // log once, keep trying
    }
  })();
}
