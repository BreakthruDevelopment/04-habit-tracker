import { pingDb } from "@/lib/db";
import { migrationState } from "@/lib/db/migrate-on-start";

export const dynamic = "force-dynamic";

/**
 * Liveness and readiness in one: every cloud's health check and the Build Tracker
 * call this. Returns 503 when the database is unreachable, or when startup
 * migrations haven't succeeded yet (they retry in the background).
 */
export async function GET() {
  const dbOk = await pingDb();
  const migrations = migrationState();
  const migrationsOk = migrations === undefined || migrations === "ok" || migrations === "skipped";
  const ok = dbOk && migrationsOk;
  const body = {
    status: ok ? "ok" : "degraded",
    app: process.env.APP_NAME ?? "30-apps-template",
    version: process.env.APP_VERSION ?? "dev",
    cloud: process.env.CLOUD ?? "local",
    checks: {
      database: dbOk ? "ok" : "unreachable",
      ...(migrations && migrations !== "skipped" ? { migrations: migrationsOk ? "ok" : migrations } : {}),
    },
    time: new Date().toISOString(),
  };
  return Response.json(body, { status: ok ? 200 : 503 });
}
