import "server-only";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "@/lib/auth/rbac";
import { type Db, db, schema } from "@/lib/db";
import {
  DAY_SECONDS,
  REMINDER_MAX_MINUTES,
  REMINDER_MIN_MINUTES,
  REMINDER_STEP_MINUTES,
  TZ_CHANGES_PER_DAY,
} from "@/lib/domain";
import { BadRequestError } from "@/lib/errors";
import { log } from "@/lib/log";
import { ownedBy } from "@/lib/owned";
import { localTodayFor, normalizeTimeZone } from "@/lib/time";
import { advisoryLock, consumeRate } from "@/lib/usage";

/**
 * What a user sees of their settings. `reminderTime` is "HH:MM" (null = no reminders). The reminder
 * bookkeeping columns (last_reminder_on, last_reminder_at) stay server-side.
 */
export type Settings = { timeZone: string; reminderTime: string | null; updatedAt: Date };

const { userSettings } = schema;

export const TZ_CHANGE_MESSAGE = `You can change your time zone ${TZ_CHANGES_PER_DAY} times in 24 hours. Try again later.`;

/** "05:00" to "21:00" in 15-minute steps, as "HH:MM". */
export function isValidReminderTime(value: string): boolean {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!m) return false;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes >= REMINDER_MIN_MINUTES && minutes <= REMINDER_MAX_MINUTES && minutes % REMINDER_STEP_MINUTES === 0;
}

export const updateSettingsSchema = z
  .object({
    timeZone: z
      .string()
      .max(64)
      .transform((v, ctx) => {
        const zone = normalizeTimeZone(v);
        if (!zone) ctx.addIssue({ code: "custom", message: "Unknown time zone" });
        return zone ?? v;
      })
      .optional(),
    reminderTime: z
      .string()
      .refine(isValidReminderTime, "Reminder time must be 05:00 to 21:00 in 15-minute steps")
      .nullable()
      .optional(),
  })
  .strict()
  .refine((v) => v.timeZone !== undefined || v.reminderTime !== undefined, "Nothing to change");

export type UpdateSettingsInput = z.input<typeof updateSettingsSchema>;

function present(row: typeof userSettings.$inferSelect): Settings {
  // A stored zone we no longer recognise is shown (and used) as UTC rather than failing the page.
  // Logged without the user id or the zone, which would identify someone.
  const timeZone = normalizeTimeZone(row.timeZone);
  if (!timeZone) log.warn("settings.zone_unknown");
  return {
    timeZone: timeZone ?? "UTC",
    // Postgres `time` comes back as "HH:MM:SS".
    reminderTime: row.reminderTime ? row.reminderTime.slice(0, 5) : null,
    updatedAt: row.updatedAt,
  };
}

/** The actor's settings, or null when they haven't been created yet. Read-only: never writes. */
export async function getSettings(actor: Actor): Promise<Settings | null> {
  const [row] = await db().select().from(userSettings).where(ownedBy(userSettings, actor));
  return row ? present(row) : null;
}

export const detectZoneSchema = z.object({ detectedZone: z.string().max(64) }).strict();

/**
 * The actor's settings, created on first use. `detectedZone` is the browser's zone
 * (`Intl.DateTimeFormat().resolvedOptions().timeZone`); it is used only when the row is created, and
 * only if it's a zone we accept, otherwise the row starts as UTC. Creating the row is not a zone
 * change, so it doesn't count against the daily limit. Safe to call concurrently.
 */
export async function getOrCreateSettings(actor: Actor, detectedZone?: string | null): Promise<Settings> {
  const zone = normalizeTimeZone(detectedZone) ?? "UTC";
  const database = db();
  const [existing] = await database.select().from(userSettings).where(ownedBy(userSettings, actor));
  if (existing) return present(existing);
  await database.insert(userSettings).values({ userId: actor.id, timeZone: zone }).onConflictDoNothing();
  const [row] = await database.select().from(userSettings).where(ownedBy(userSettings, actor));
  return present(row);
}

/**
 * Change the actor's time zone and/or reminder time. Only the actor's own row is ever touched.
 * A change to a different zone is limited to 3 per rolling 24 hours (a 429 after that); sending
 * the zone you already have is a no-op and costs nothing. `now` is a parameter so tests can pin the clock.
 */
export async function updateSettings(actor: Actor, input: UpdateSettingsInput, now: Date = new Date()): Promise<Settings> {
  const parsed = updateSettingsSchema.safeParse(input);
  if (!parsed.success) throw parsed.error;
  const { timeZone, reminderTime } = parsed.data;

  return db().transaction(async (tx) => {
    // One writer per user at a time: the zone-change count and the update must agree.
    await advisoryLock(tx, `settings:${actor.id}`);
    await tx.insert(userSettings).values({ userId: actor.id }).onConflictDoNothing();
    const [current] = await tx.select().from(userSettings).where(ownedBy(userSettings, actor));
    if (!current) throw new BadRequestError("Settings unavailable");

    const changes: Partial<typeof userSettings.$inferInsert> = {};
    if (timeZone !== undefined && timeZone !== current.timeZone) {
      await consumeRate(tx, actor.id, "tz_change", TZ_CHANGES_PER_DAY, TZ_CHANGE_MESSAGE, {
        windowSeconds: DAY_SECONDS,
        now,
      });
      changes.timeZone = timeZone;
    }
    if (reminderTime !== undefined) {
      changes.reminderTime = reminderTime === null ? null : `${reminderTime}:00`;
    }
    if (Object.keys(changes).length === 0) return present(current);

    const [row] = await tx
      .update(userSettings)
      .set({ ...changes, updatedAt: sql`${now.toISOString()}::timestamptz` })
      .where(ownedBy(userSettings, actor))
      .returning();
    return present(row);
  });
}

/**
 * The actor's time zone and today's date there, read from the stored settings (UTC if the row doesn't
 * exist yet). Never throws on a stored zone it doesn't recognise (see `localTodayFor`). `executor` lets
 * a caller read inside its own transaction.
 */
export async function getLocalDay(
  actor: Actor,
  now: Date,
  executor: Pick<Db, "select"> = db(),
): Promise<{ timeZone: string; today: string }> {
  const [row] = await executor.select({ timeZone: userSettings.timeZone }).from(userSettings).where(ownedBy(userSettings, actor));
  const timeZone = normalizeTimeZone(row?.timeZone) ?? "UTC";
  return { timeZone, today: localTodayFor(timeZone, now) };
}
