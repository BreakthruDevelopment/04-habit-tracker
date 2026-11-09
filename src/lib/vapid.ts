import "server-only";
import { createHash } from "node:crypto";
import { eq, ne } from "drizzle-orm";
import { generateVAPIDKeys } from "web-push";
import { type Db, db, schema } from "@/lib/db";
import { log } from "@/lib/log";
import { advisoryLock } from "@/lib/usage";

const { appSettings, pushSubscription } = schema;

export type VapidKeys = { publicKey: string; privateKey: string; keyId: string };

/** First 8 hex characters of the SHA-256 of the public key: stored on each subscription so a rotation can prune. */
export function keyIdFor(publicKey: string): string {
  return createHash("sha256").update(publicKey).digest("hex").slice(0, 8);
}

/**
 * Read the single app_settings row, creating it if missing. Many instances may start at once, so creation
 * happens in a transaction holding an advisory lock, re-reads, and inserts with on conflict do nothing: exactly one
 * pair is ever written and every caller gets it. Subscriptions made under another key are then pruned
 * (this is what a rotation, deleting the row and restarting, relies on). Uncached: `getVapidKeys` caches per process.
 *
 * ROTATION: delete the app_settings row and restart EVERY instance. Each process caches its pair in memory, so an
 * instance that isn't restarted keeps the old pair (and, having pruned nothing, would store subscriptions under the old
 * key id until another instance's next load prunes them). Everyone has to turn reminders on again afterwards.
 * Errors thrown here carry no driver message (see the catch below), so callers may log them.
 */
export async function loadOrCreateVapidKeys(database: Db = db()): Promise<VapidKeys> {
  try {
    return await loadOrCreate(database);
  } catch (err) {
    // Never let the driver's message escape: Drizzle's query errors include the statement's parameters,
    // and a failed insert's parameters are the private key. Only the Postgres error code is kept.
    const code = (err as { cause?: { code?: unknown } }).cause?.code ?? (err as { code?: unknown }).code;
    throw new Error(`VAPID key load failed (${typeof code === "string" ? code : "unknown"})`);
  }
}

async function loadOrCreate(database: Db): Promise<VapidKeys> {
  const read = async (d: Pick<Db, "select">) => {
    const [row] = await d.select().from(appSettings).where(eq(appSettings.id, 1));
    return row;
  };
  let row = await read(database);
  if (!row) {
    row = await database.transaction(async (tx) => {
      await advisoryLock(tx, "vapid-keys");
      if (!(await read(tx))) {
        const pair = generateVAPIDKeys();
        await tx
          .insert(appSettings)
          .values({ id: 1, vapidPublicKey: pair.publicKey, vapidPrivateKey: pair.privateKey, vapidKeyId: keyIdFor(pair.publicKey) })
          .onConflictDoNothing();
        log.info("vapid.generated");
      }
      return (await read(tx))!;
    });
  }
  const pruned = await database.delete(pushSubscription).where(ne(pushSubscription.vapidKeyId, row.vapidKeyId)).returning({ id: pushSubscription.id });
  if (pruned.length > 0) log.warn("vapid.pruned_subscriptions", { count: pruned.length });
  return { publicKey: row.vapidPublicKey, privateKey: row.vapidPrivateKey, keyId: row.vapidKeyId };
}

// Instrumentation and route handlers can load separate copies of this module, so the cache lives on globalThis.
const CACHE = Symbol.for("30apps.vapidKeys");
const PENDING = Symbol.for("30apps.vapidPending");
type Holder = { [CACHE]?: VapidKeys; [PENDING]?: Promise<VapidKeys> };

/** The key pair, loaded once per process (concurrent callers share one load; a failure isn't cached). */
export async function getVapidKeys(): Promise<VapidKeys> {
  const h = globalThis as Holder;
  if (h[CACHE]) return h[CACHE];
  h[PENDING] ??= loadOrCreateVapidKeys()
    .then((keys) => (h[CACHE] = keys))
    .finally(() => {
      h[PENDING] = undefined;
    });
  return h[PENDING];
}

/** True once the keys are loaded in this process. */
export function vapidLoaded(): boolean {
  return (globalThis as Holder)[CACHE] !== undefined;
}

/** For tests only. */
export function resetVapidCache(): void {
  const h = globalThis as Holder;
  h[CACHE] = undefined;
  h[PENDING] = undefined;
}

