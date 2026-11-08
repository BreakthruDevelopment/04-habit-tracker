import "server-only";
import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { type Actor, assertCan } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { BACKFILL_DAYS, CHECKINS_PER_HOUR } from "@/lib/domain";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/errors";
import { decimalSchema, parseHabitId, trimNumeric } from "@/lib/habits";
import { ownedBy } from "@/lib/owned";
import { getLocalDay } from "@/lib/settings";
import { daysBetween, isValidDate, localTodayFor } from "@/lib/time";
import { consumeRate } from "@/lib/usage";

const { habit, checkIn } = schema;

export type CheckInView = { habitId: string; date: string; value: string; done: boolean; updatedAt: Date };

const LIMIT_MESSAGE = `You can save ${CHECKINS_PER_HOUR} check-ins an hour. Try again later.`;

/** Cents as an integer, so "0.29" >= "0.29" can't be fooled by floating point. */
const cents = (v: string) => Math.round(Number(v) * 100);

function parseDate(date: unknown): string {
  if (!isValidDate(date)) throw new BadRequestError("Date must be a real date like 2026-11-08.");
  return date;
}

/** Today and the 7 days before it, in the user's own zone (computed here, never sent by the client). */
function assertInWindow(date: string, today: string): void {
  const back = daysBetween(date, today);
  if (back < 0) throw new BadRequestError("You can't check in for a future date.");
  if (back > BACKFILL_DAYS) throw new BadRequestError(`You can only change the last ${BACKFILL_DAYS} days.`);
}

const bodySchema = z.object({ value: decimalSchema.optional() }).strict();

/**
 * Record (or replace) the check-in for one habit on one local date. Upserts on the primary key, so repeating a
 * request is harmless. A yes/no habit always stores 1 (a value other than 1 is a 400); a numeric habit needs a
 * `value`, and `done` is fixed now as value >= the habit's current daily target. `now` is a parameter so tests
 * can pin the clock.
 */
export async function setCheckIn(actor: Actor, habitId: string, date: string, input?: unknown, now?: Date): Promise<CheckInView> {
  assertCan(actor, "create");
  const id = parseHabitId(habitId);
  const localDate = parseDate(date);
  const { value } = bodySchema.parse(input ?? {});
  return db().transaction(async (tx) => {
    // Share-lock the habit so it can't be deleted between the check and the insert.
    const [h] = await tx.select().from(habit).where(ownedBy(habit, actor, eq(habit.id, id))).for("share").limit(1);
    if (!h) throw new NotFoundError("Habit not found");
    const { today, timeZone } = await getLocalDay(actor, now ?? new Date(), tx);
    assertInWindow(localDate, today);
    if (h.archivedAt) throw new ConflictError("This habit is archived. Restore it to check in.");
    // No check-ins for days before the habit existed (its creation day in the user's zone).
    if (localDate < localTodayFor(timeZone, h.createdAt)) throw new BadRequestError("That day is before you created this habit.");

    let stored: string;
    let done: boolean;
    if (h.kind === "check") {
      if (value !== undefined && cents(value) !== 100) throw new BadRequestError("A yes/no habit is checked in with a value of 1.");
      stored = "1";
      done = true;
    } else {
      if (value === undefined) throw new BadRequestError("A numeric habit needs a value.");
      stored = value;
      done = cents(value) >= cents(h.dailyTarget ?? "0");
    }

    await consumeRate(tx, actor.id, "checkin", CHECKINS_PER_HOUR, LIMIT_MESSAGE, { now });
    const [row] = await tx
      .insert(checkIn)
      .values({ habitId: id, localDate, ownerId: actor.id, value: stored, done })
      .onConflictDoUpdate({
        target: [checkIn.habitId, checkIn.localDate],
        set: { value: stored, done, updatedAt: sql`now()` },
      })
      .returning();
    return { habitId: id, date: row.localDate, value: trimNumeric(row.value), done: row.done, updatedAt: row.updatedAt };
  });
}

/** Remove a check-in (uncheck). Same window and ownership rules; removing one that isn't there is fine. */
export async function clearCheckIn(actor: Actor, habitId: string, date: string, now?: Date): Promise<void> {
  assertCan(actor, "create");
  const id = parseHabitId(habitId);
  const localDate = parseDate(date);
  await db().transaction(async (tx) => {
    const [h] = await tx.select({ id: habit.id, archivedAt: habit.archivedAt }).from(habit).where(ownedBy(habit, actor, eq(habit.id, id))).for("share").limit(1);
    if (!h) throw new NotFoundError("Habit not found");
    const { today } = await getLocalDay(actor, now ?? new Date(), tx);
    assertInWindow(localDate, today);
    if (h.archivedAt) throw new ConflictError("This habit is archived. Restore it to change its check-ins.");
    await consumeRate(tx, actor.id, "checkin", CHECKINS_PER_HOUR, LIMIT_MESSAGE, { now });
    await tx.delete(checkIn).where(and(ownedBy(checkIn, actor, eq(checkIn.habitId, id), eq(checkIn.localDate, localDate))));
  });
}
