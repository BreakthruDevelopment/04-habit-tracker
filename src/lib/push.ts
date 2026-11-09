import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { sendNotification } from "web-push";
import { z } from "zod";
import { type Actor, assertCan } from "@/lib/auth/rbac";
import { client, db, schema } from "@/lib/db";
import {
  MAX_PUSH_DEVICES,
  PUSH_MAX_FAILURES,
  PUSH_SEND_CONCURRENCY,
  PUSH_STALE_DAYS,
  PUSH_TIMEOUT_MS,
  PUSH_TTL_SECONDS,
  REMINDER_MAX_USERS_PER_RUN,
  REMINDER_MIN_GAP_HOURS,
  REMINDER_WINDOW_HOURS,
  SUBSCRIBES_PER_HOUR,
  TEST_PUSHES_PER_HOUR,
} from "@/lib/domain";
import { env } from "@/lib/env";
import { BadRequestError, HttpError, NotFoundError } from "@/lib/errors";
import { log } from "@/lib/log";
import { ownedBy } from "@/lib/owned";
import { advisoryLock, consumeRate, dailyCount, releaseRate, reserveDaily } from "@/lib/usage";
import { type VapidKeys, getVapidKeys } from "@/lib/vapid";

const { pushSubscription } = schema;

// ---------------------------------------------------------------------------
// Endpoint allow-list (SSRF) and input validation
// ---------------------------------------------------------------------------

const EXACT_HOSTS = new Set(["fcm.googleapis.com", "web.push.apple.com"]);
const HOST_SUFFIXES = [".push.services.mozilla.com", ".notify.windows.com"];

/** `https:` on a known push service host only, so the server can't be made to POST to arbitrary URLs. */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  if (endpoint.length > 1024) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  // Only the canonical form is stored, so the allow-list check and what we later POST to are the same string.
  if (url.href !== endpoint) return false;
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (url.port !== "" && url.port !== "443") return false;
  const host = url.hostname;
  return EXACT_HOSTS.has(host) || HOST_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length);
}

/** base64url (no padding) that decodes to exactly `bytes` bytes. */
function b64Bytes(bytes: number, chars: number) {
  return z
    .string()
    .regex(new RegExp(`^[A-Za-z0-9_-]{${chars}}$`), "Invalid key")
    .refine((v) => Buffer.from(v, "base64url").length === bytes, "Invalid key");
}

export const subscribeSchema = z
  .object({
    endpoint: z.string().max(1024).refine(isAllowedPushEndpoint, "Unsupported push service"),
    // PushSubscription.toJSON() always includes expirationTime (null in Chrome, Firefox and Safari). Accepted and ignored.
    expirationTime: z.number().nonnegative().nullable().optional(),
    keys: z
      .object({
        // An uncompressed P-256 point: 65 bytes starting with 0x04.
        p256dh: b64Bytes(65, 87).refine((v) => Buffer.from(v, "base64url")[0] === 4, "Invalid key"),
        auth: b64Bytes(16, 22),
      })
      .strict(),
  })
  .strict();

export const unsubscribeSchema = z.union([
  z.object({ endpoint: z.string().max(1024) }).strict(),
  z.object({ id: z.uuid() }).strict(),
]);

/** "Chrome on Android" from the User-Agent; never stores the raw header. */
export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(ua)
          ? "Mac"
          : /CrOS/.test(ua)
            ? "ChromeOS"
            : /Linux/.test(ua)
              ? "Linux"
              : null;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\/|FxiOS/.test(ua)
      ? "Firefox"
      : /CriOS|Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? "Browser";
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export type DeviceView = { id: string; endpoint: string; deviceLabel: string; createdAt: Date; lastSuccessAt: Date | null };

function toView(r: typeof pushSubscription.$inferSelect): DeviceView {
  return { id: r.id, endpoint: r.endpoint, deviceLabel: r.deviceLabel, createdAt: r.createdAt, lastSuccessAt: r.lastSuccessAt };
}

const UNAVAILABLE = "Reminders aren't available right now.";

async function keysOrThrow(): Promise<VapidKeys> {
  try {
    return await getVapidKeys();
  } catch (err) {
    log.error("push.keys_unavailable", { error: err instanceof Error ? err.message : String(err) });
    throw new HttpError(503, UNAVAILABLE);
  }
}

/** Same as `getVapidKeys` but null instead of throwing (config and health). */
export async function vapidKeysOrNull(): Promise<VapidKeys | null> {
  try {
    return await getVapidKeys();
  } catch {
    return null;
  }
}

export async function listDevices(actor: Actor): Promise<DeviceView[]> {
  assertCan(actor, "read", { ownerId: actor.id });
  const rows = await db().select().from(pushSubscription).where(ownedBy(pushSubscription, actor)).orderBy(asc(pushSubscription.createdAt));
  return rows.map(toView);
}

/**
 * Store this device's subscription for the actor. An endpoint already stored for another user moves to the actor
 * (a shared browser belongs to whoever signed in last). At most 5 devices per user: the oldest is replaced.
 * `userAgent` only becomes a short label such as "Chrome on Android".
 */
export async function subscribe(actor: Actor, input: unknown, userAgent?: string | null): Promise<DeviceView> {
  assertCan(actor, "create");
  const data = subscribeSchema.parse(input);
  const keys = await keysOrThrow();
  return db().transaction(async (tx) => {
    await consumeRate(tx, actor.id, "subscribe", SUBSCRIBES_PER_HOUR, `You can add ${SUBSCRIBES_PER_HOUR} devices an hour. Try again later.`);
    await advisoryLock(tx, `push-devices:${actor.id}`);
    const [row] = await tx
      .insert(pushSubscription)
      .values({
        userId: actor.id,
        endpoint: data.endpoint,
        p256dh: data.keys.p256dh,
        auth: data.keys.auth,
        deviceLabel: deviceLabel(userAgent),
        vapidKeyId: keys.keyId,
      })
      .onConflictDoUpdate({
        target: pushSubscription.endpoint,
        set: {
          userId: actor.id,
          p256dh: data.keys.p256dh,
          auth: data.keys.auth,
          deviceLabel: deviceLabel(userAgent),
          vapidKeyId: keys.keyId,
          createdAt: sql`now()`,
          failureCount: 0,
          lastStatus: null,
          lastSuccessAt: null,
        },
        // An endpoint is a capability held by one browser. Another account may take it over only by presenting the same
        // keys (which only that browser has); otherwise the row stays with its owner and nothing is returned.
        setWhere: sql`${pushSubscription.userId} = ${actor.id} or (${pushSubscription.auth} = excluded.auth and ${pushSubscription.p256dh} = excluded.p256dh)`,
      })
      .returning();
    if (!row) throw new HttpError(409, "This device is set up for another account.");
    const mine = await tx.select({ id: pushSubscription.id }).from(pushSubscription).where(ownedBy(pushSubscription, actor)).orderBy(asc(pushSubscription.createdAt), asc(pushSubscription.id));
    const extra = mine.length - MAX_PUSH_DEVICES;
    if (extra > 0) {
      const drop = mine.filter((m) => m.id !== row.id).slice(0, extra).map((m) => m.id);
      await tx.delete(pushSubscription).where(inArray(pushSubscription.id, drop));
    }
    return toView(row);
  });
}

/** Remove one of the actor's own devices by endpoint or id. 404 when it isn't theirs (or is already gone). */
export async function unsubscribe(actor: Actor, input: unknown): Promise<void> {
  assertCan(actor, "delete", { ownerId: actor.id });
  const data = unsubscribeSchema.parse(input);
  const match = "id" in data ? eq(pushSubscription.id, data.id) : eq(pushSubscription.endpoint, data.endpoint);
  const gone = await db().delete(pushSubscription).where(ownedBy(pushSubscription, actor, match)).returning({ id: pushSubscription.id });
  if (gone.length === 0) throw new NotFoundError("Device not found");
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** Payloads carry counts only, never habit names (they show on lock screens). */
export type PushPayload = { title: string; body: string; url: string; tag: string };
export type SendResult = { sent: number; removed: number; failed: number };

/** State shared by the sends of one run: hosts that answered 429, and whether the daily cap was reached. */
export type SendContext = { blockedHosts: Set<string>; capped: boolean; /** epoch ms after which nothing new is started */ deadline?: number };
export const newSendContext = (deadline?: number): SendContext => ({ blockedHosts: new Set(), capped: false, deadline });

/** One process-wide limit on sends in flight, however many users and devices are being served at once. */
function createGate(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next(); // hand the slot over
      else active--;
    }
  };
}
const sendGate = createGate(PUSH_SEND_CONCURRENCY);

type Sub = typeof pushSubscription.$inferSelect;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

async function sendOne(sub: Sub, body: string, keys: VapidKeys, topic: string | undefined, ctx: SendContext, now: Date): Promise<keyof SendResult | "skipped"> {
  const database = db();
  if (!isAllowedPushEndpoint(sub.endpoint)) {
    // Stored endpoints were validated on the way in; if one is ever not allowed, drop it rather than call it.
    await database.delete(pushSubscription).where(eq(pushSubscription.id, sub.id));
    return "removed";
  }
  const host = new URL(sub.endpoint).hostname;
  if (ctx.blockedHosts.has(host) || ctx.capped || (ctx.deadline !== undefined && Date.now() > ctx.deadline)) return "skipped";
  if (!(await reserveDaily(database, "push", env().PUSH_DAILY_CAP))) {
    ctx.capped = true;
    log.warn("push.daily_cap_reached");
    return "skipped";
  }
  try {
    const res = await sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body, {
      vapidDetails: { subject: env().VAPID_SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey },
      TTL: PUSH_TTL_SECONDS,
      urgency: "normal",
      timeout: PUSH_TIMEOUT_MS,
      ...(topic ? { topic } : {}),
    });
    await database
      .update(pushSubscription)
      .set({ lastSuccessAt: sql`${now.toISOString()}::timestamptz`, failureCount: 0, lastStatus: res.statusCode })
      .where(eq(pushSubscription.id, sub.id));
    return "sent";
  } catch (err) {
    const status = (err as { statusCode?: unknown }).statusCode;
    const code = typeof status === "number" ? status : null;
    if (code === 404 || code === 410) {
      await database.delete(pushSubscription).where(eq(pushSubscription.id, sub.id));
      return "removed";
    }
    if (code === 429) {
      ctx.blockedHosts.add(host);
      await database.update(pushSubscription).set({ lastStatus: 429 }).where(eq(pushSubscription.id, sub.id));
      log.warn("push.rate_limited", { host });
      return "failed";
    }
    if (code === 400 || code === 413) {
      await database.update(pushSubscription).set({ lastStatus: code }).where(eq(pushSubscription.id, sub.id));
      log.warn("push.rejected", { status: code });
      return "failed";
    }
    // Timeouts, network errors and 5xx: count it, and drop the device after too many in a row.
    const [row] = await database
      .update(pushSubscription)
      .set({ failureCount: sql`${pushSubscription.failureCount} + 1`, lastStatus: code })
      .where(eq(pushSubscription.id, sub.id))
      .returning({ failures: pushSubscription.failureCount });
    if (row && row.failures >= PUSH_MAX_FAILURES) {
      await database.delete(pushSubscription).where(eq(pushSubscription.id, sub.id));
      return "removed";
    }
    log.warn("push.send_failed", { status: code });
    return "failed";
  }
}

/** Send `payload` to every device of `userId`, handling each status as the spec says. Never throws for a push-service error. */
export async function sendToUser(
  userId: string,
  payload: PushPayload,
  opts: { topic?: string; ctx?: SendContext; now?: Date; keys?: VapidKeys } = {},
): Promise<SendResult> {
  const keys = opts.keys ?? (await keysOrThrow());
  const ctx = opts.ctx ?? newSendContext();
  const now = opts.now ?? new Date();
  const body = JSON.stringify(payload);
  const subs = await db()
    .select()
    .from(pushSubscription)
    .where(and(eq(pushSubscription.userId, userId), eq(pushSubscription.vapidKeyId, keys.keyId)));
  const results = await Promise.all(subs.map((s) => sendGate(() => sendOne(s, body, keys, opts.topic, ctx, now))));
  const count = (k: string) => results.filter((r) => r === k).length;
  return { sent: count("sent"), removed: count("removed"), failed: count("failed") };
}

/** "Test reminder" to the actor's own devices. 3 an hour; the attempt isn't counted when there's nothing to send to. */
export async function sendTestPush(actor: Actor, now?: Date): Promise<SendResult> {
  assertCan(actor, "create");
  const keys = await keysOrThrow();
  await db().transaction((tx) =>
    consumeRate(tx, actor.id, "test_push", TEST_PUSHES_PER_HOUR, `You can send ${TEST_PUSHES_PER_HOUR} test reminders an hour. Try again later.`),
  );
  const result = await sendToUser(
    actor.id,
    { title: "Habits", body: "Test reminder: this device is set up.", url: "/today", tag: "test-reminder" },
    { keys, now },
  );
  if (result.sent + result.removed + result.failed === 0) {
    await db().transaction((tx) => releaseRate(tx, actor.id, "test_push"));
    throw new BadRequestError("No device is set up for reminders. Turn them on for this device first.");
  }
  return result;
}

/** Delete subscriptions with too many failures in a row, or no success in 60 days. */
export async function pruneSubscriptions(now: Date): Promise<number> {
  const rows = await db()
    .delete(pushSubscription)
    .where(
      sql`${pushSubscription.failureCount} >= ${PUSH_MAX_FAILURES} or coalesce(${pushSubscription.lastSuccessAt}, ${pushSubscription.createdAt}) < ${now.toISOString()}::timestamptz - make_interval(days => ${PUSH_STALE_DAYS})`,
    )
    .returning({ id: pushSubscription.id });
  return rows.length;
}

// ---------------------------------------------------------------------------
// The reminder run
// ---------------------------------------------------------------------------

export type ReminderResult =
  | { considered: number; claimed: number; sent: number; removed: number; failed: number }
  | { skipped: "busy" | "unavailable" };

/** No new user is claimed and no new send starts after this long into a run, so a stuck run can't hold its tick forever. */
const RUN_DEADLINE_MS = 4 * 60_000;

type Eligible = { user_id: string; time_zone: string; reminder_time: string; local_date: string };

/**
 * Remind every user whose reminder time has come, once per local day, only when something is still open.
 * Eligibility is computed with timestamps (never wall-clock text), so 23- and 25-hour days still give one
 * reminder: from the chosen local time for 3 hours, never past local midnight. Each user is claimed
 * (last_reminder_on/at written) BEFORE sending, so a crash skips a day rather than sending twice, and a 12 h gap
 * keeps a zone change that repeats the local date from reminding twice. `now` is a parameter so tests pin the clock.
 */
export async function runReminders(now: Date): Promise<ReminderResult> {
  const reserved = await client().reserve();
  try {
    const [{ locked }] = await reserved<{ locked: boolean }[]>`select pg_try_advisory_lock(hashtextextended('reminders:run', 0)) as locked`;
    if (!locked) return { skipped: "busy" };
    try {
      return await run(now);
    } finally {
      try {
        await reserved`select pg_advisory_unlock(hashtextextended('reminders:run', 0))`;
      } catch (err) {
        log.error("reminders.unlock_failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    reserved.release();
  }
}

async function run(now: Date): Promise<ReminderResult> {
  const database = db();
  const stamp = sql`${now.toISOString()}::timestamptz`;
  await pruneSubscriptions(now);
  let keys: VapidKeys;
  try {
    keys = await getVapidKeys();
  } catch (err) {
    log.error("reminders.keys_unavailable", { error: err instanceof Error ? err.message : String(err) });
    return { skipped: "unavailable" };
  }
  const gap = sql`make_interval(hours => ${REMINDER_MIN_GAP_HOURS})`;

  // time_zone must be one Postgres knows, so a single bad zone can never make `at time zone` fail the whole run.
  const eligible = await database.execute<Eligible>(sql`
    with known as materialized (
      -- Filter first, in a CTE the planner can't inline, so 'at time zone' below never sees an unknown zone.
      select s.user_id, s.time_zone, s.reminder_time, s.last_reminder_on, s.last_reminder_at
      from user_settings s
      where s.reminder_time is not null
        and s.time_zone in (select name from pg_timezone_names)
        and exists (select 1 from push_subscription p where p.user_id = s.user_id and p.vapid_key_id = ${keys.keyId})
    ), z as (
      select k.*, (${stamp} at time zone k.time_zone)::date as local_date from known k
    ), w as (
      select z.*, (z.local_date + z.reminder_time) at time zone z.time_zone as starts_at,
             ((z.local_date + 1)::timestamp at time zone z.time_zone) as day_end
      from z
    )
    select user_id, time_zone, reminder_time::text as reminder_time, to_char(local_date, 'YYYY-MM-DD') as local_date
    from w
    where ${stamp} >= starts_at
      and ${stamp} < least(starts_at + make_interval(hours => ${REMINDER_WINDOW_HOURS}), day_end)
      and last_reminder_on is distinct from local_date
      and (last_reminder_at is null or last_reminder_at < ${stamp} - ${gap})
    order by user_id
    limit ${REMINDER_MAX_USERS_PER_RUN}
  `);

  const deadline = Date.now() + RUN_DEADLINE_MS;
  const ctx = newSendContext(deadline);
  const totals = { considered: eligible.length, claimed: 0, sent: 0, removed: 0, failed: 0 };

  await mapLimit([...eligible], PUSH_SEND_CONCURRENCY, async (u) => {
    // Don't claim (and so don't use up the day of) a user we can't send to: the daily cap is checked first.
    if (ctx.capped || Date.now() > deadline) return;
    if ((await dailyCount("push")) >= env().PUSH_DAILY_CAP) {
      ctx.capped = true;
      log.warn("push.daily_cap_reached");
      return;
    }
    // Claim first. The conditions repeat, and the zone and time must be unchanged since the read above.
    const claimed = await database.execute<{ user_id: string }>(sql`
      update user_settings
      set last_reminder_on = ${u.local_date}::date, last_reminder_at = ${stamp}
      where user_id = ${u.user_id} and time_zone = ${u.time_zone} and reminder_time = ${u.reminder_time}::time
        and last_reminder_on is distinct from ${u.local_date}::date
        and (last_reminder_at is null or last_reminder_at < ${stamp} - ${gap})
      returning user_id
    `);
    if (claimed.length === 0) return;
    totals.claimed++;

    // Habits still open on the local date SQL returned (never recomputed in JS): active, not done that day,
    // and this ISO week's goal not already met.
    const [{ open }] = await database.execute<{ open: number }>(sql`
      select count(*)::int as open
      from habit h
      where h.owner_id = ${u.user_id} and h.archived_at is null
        and not exists (
          select 1 from check_in c where c.habit_id = h.id and c.owner_id = h.owner_id and c.local_date = ${u.local_date}::date and c.done
        )
        and (
          select count(*) from check_in c where c.habit_id = h.id and c.owner_id = h.owner_id and c.done
            and c.local_date between date_trunc('week', ${u.local_date}::date)::date and date_trunc('week', ${u.local_date}::date)::date + 6
        ) < h.weekly_goal
    `);
    if (open === 0) return;

    const body = `${open} ${open === 1 ? "habit" : "habits"} left today`;
    const r = await sendToUser(u.user_id, { title: "Habits", body, url: "/today", tag: "daily-reminder" }, { topic: "daily-reminder", ctx, now, keys });
    totals.sent += r.sent;
    totals.removed += r.removed;
    totals.failed += r.failed;
  });

  log.info("reminders.run", totals);
  return totals;
}
