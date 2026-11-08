import "server-only";
import { and, asc, count, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { type Actor, assertCan } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import {
  HABIT_KINDS,
  HABIT_NAME_MAX,
  HABIT_UNIT_MAX,
  HABIT_WRITES_PER_HOUR,
  MAX_ACTIVE_HABITS,
  MAX_TOTAL_HABITS,
  MAX_VALUE,
} from "@/lib/domain";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/errors";
import { ownedBy } from "@/lib/owned";
import { advisoryLock, consumeRate } from "@/lib/usage";

const { habit, checkIn } = schema;

/** A habit as the API returns it. `updatedAt` is the conflict token PATCH needs back. */
export type HabitView = {
  id: string;
  name: string;
  kind: (typeof HABIT_KINDS)[number];
  unit: string | null;
  dailyTarget: string | null;
  weeklyGoal: number;
  position: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** "2.50" to "2.5" and "1.00" to "1": numerics come back from Postgres with their scale. */
export function trimNumeric(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

export function toHabitView(row: typeof habit.$inferSelect): HabitView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    unit: row.unit,
    dailyTarget: row.dailyTarget === null ? null : trimNumeric(row.dailyTarget),
    weeklyGoal: row.weeklyGoal,
    position: row.position,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** A habit id that isn't a UUID can't name a habit: 404 rather than a database error. */
export function parseHabitId(id: unknown): string {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) throw new NotFoundError("Habit not found");
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** A decimal with at most 2 places, as a string, above 0 and at most MAX_VALUE. Numbers are accepted and stringified. */
export const decimalSchema = z
  .union([z.string(), z.number().finite()])
  .transform((v) => String(v).trim())
  .pipe(z.string().regex(/^\d{1,6}(\.\d{1,2})?$/, "Use a number with at most 2 decimals, for example 8 or 2.5"))
  .refine((v) => Number(v) > 0 && Number(v) <= MAX_VALUE, `Must be above 0 and at most ${MAX_VALUE}`);

const nameSchema = z.string().trim().min(1, "Name is required").max(HABIT_NAME_MAX);
const unitSchema = z.string().trim().min(1).max(HABIT_UNIT_MAX);
const goalSchema = z.number().int().min(1).max(7);

export const createHabitSchema = z
  .object({
    name: nameSchema,
    kind: z.enum(HABIT_KINDS).default("check"),
    unit: unitSchema.nullish(),
    dailyTarget: decimalSchema.nullish(),
    weeklyGoal: goalSchema.default(7),
  })
  .strict();

export const updateHabitSchema = z
  .object({
    updatedAt: z.iso.datetime({ offset: true }),
    name: nameSchema.optional(),
    kind: z.enum(HABIT_KINDS).optional(),
    unit: unitSchema.nullish(),
    dailyTarget: decimalSchema.nullish(),
    weeklyGoal: goalSchema.optional(),
    archived: z.boolean().optional(),
  })
  .strict();

/**
 * A yes/no habit has no unit or target; a numeric habit has both. (The database CHECK says the same; this
 * turns a violation into a 400 with a reason.)
 */
function shape(kind: HabitView["kind"], unit: string | null | undefined, target: string | null | undefined) {
  if (kind === "numeric") {
    if (!unit || !target) throw new BadRequestError("A numeric habit needs a unit and a daily target.");
    return { unit, dailyTarget: target };
  }
  if (unit || target) throw new BadRequestError("A yes/no habit has no unit or daily target.");
  return { unit: null, dailyTarget: null };
}

/** The conflict token must always move forward, even for two writes in one millisecond. */
const nextUpdatedAt = () => sql`greatest(now(), ${habit.updatedAt} + interval '1 millisecond')`;

const WRITE_LIMIT_MESSAGE = `You can change habits ${HABIT_WRITES_PER_HOUR} times an hour. Try again later.`;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getHabit(actor: Actor, id: string): Promise<HabitView> {
  const [row] = await db()
    .select()
    .from(habit)
    .where(ownedBy(habit, actor, eq(habit.id, parseHabitId(id))))
    .limit(1);
  if (!row) throw new NotFoundError("Habit not found");
  return toHabitView(row);
}

/** The actor's own habits in display order: active ones by default, archived ones with `{ archived: true }`. */
export async function listHabits(actor: Actor, opts: { archived?: boolean } = {}): Promise<HabitView[]> {
  const rows = await db()
    .select()
    .from(habit)
    .where(ownedBy(habit, actor, opts.archived ? isNotNull(habit.archivedAt) : isNull(habit.archivedAt)))
    .orderBy(asc(habit.position), asc(habit.createdAt), asc(habit.id));
  return rows.map(toHabitView);
}

// ---------------------------------------------------------------------------
// Writes. Each runs in one transaction under a per-user lock, so concurrent requests can't slip past the caps.
// ---------------------------------------------------------------------------

type Tx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];

async function nextPosition(tx: Tx, actor: Actor): Promise<number> {
  const [{ max }] = await tx
    .select({ max: sql<number | null>`max(${habit.position})` })
    .from(habit)
    .where(ownedBy(habit, actor, isNull(habit.archivedAt)));
  return (max ?? -1) + 1;
}

async function activeCount(tx: Tx, actor: Actor): Promise<number> {
  const [{ n }] = await tx.select({ n: count() }).from(habit).where(ownedBy(habit, actor, isNull(habit.archivedAt)));
  return n;
}

const activeCapMessage = `You can have at most ${MAX_ACTIVE_HABITS} active habits. Archive one to add another.`;

export async function createHabit(actor: Actor, input: unknown): Promise<HabitView> {
  assertCan(actor, "create");
  const data = createHabitSchema.parse(input);
  const { unit, dailyTarget } = shape(data.kind, data.unit, data.dailyTarget);
  return db().transaction(async (tx) => {
    await advisoryLock(tx, `habit-write:${actor.id}`);
    await consumeRate(tx, actor.id, "habit_write", HABIT_WRITES_PER_HOUR, WRITE_LIMIT_MESSAGE);
    const [{ total }] = await tx.select({ total: count() }).from(habit).where(ownedBy(habit, actor));
    if (total >= MAX_TOTAL_HABITS) {
      throw new ConflictError(`You can keep at most ${MAX_TOTAL_HABITS} habits. Delete one to add another.`);
    }
    if ((await activeCount(tx, actor)) >= MAX_ACTIVE_HABITS) throw new ConflictError(activeCapMessage);
    const [row] = await tx
      .insert(habit)
      .values({
        ownerId: actor.id,
        name: data.name,
        kind: data.kind,
        unit,
        dailyTarget,
        weeklyGoal: data.weeklyGoal,
        position: await nextPosition(tx, actor),
      })
      .returning();
    return toHabitView(row);
  });
}

/**
 * Edit a habit. `updatedAt` must be the value the client last saw (409 when stale). The kind can't change
 * once the habit has check-ins. Changing a target never rewrites old check-ins: `done` is fixed when written.
 * `archived: true|false` archives or restores it.
 */
export async function updateHabit(actor: Actor, id: string, input: unknown): Promise<HabitView> {
  const habitId = parseHabitId(id);
  const data = updateHabitSchema.parse(input);
  return db().transaction(async (tx) => {
    await advisoryLock(tx, `habit-write:${actor.id}`);
    // Not ours or missing: 404, whatever the token says.
    const [current] = await tx.select().from(habit).where(ownedBy(habit, actor, eq(habit.id, habitId))).for("update").limit(1);
    if (!current) throw new NotFoundError("Habit not found");
    if (current.updatedAt.getTime() !== new Date(data.updatedAt).getTime()) {
      throw new ConflictError("This habit changed since you opened it. Reload to see the latest version.");
    }
    await consumeRate(tx, actor.id, "habit_write", HABIT_WRITES_PER_HOUR, WRITE_LIMIT_MESSAGE);

    const kind = data.kind ?? current.kind;
    if (kind !== current.kind) {
      const [used] = await tx.select({ one: sql<number>`1` }).from(checkIn).where(ownedBy(checkIn, actor, eq(checkIn.habitId, habitId))).limit(1);
      if (used) throw new ConflictError("This habit has check-ins, so its type can't change. Add a new habit instead.");
    }
    // Sending a field means "use this value" (null clears it); leaving it out keeps the current one. A switch of
    // kind starts from nothing, so the new kind's fields must come from the request.
    const keep = kind === current.kind;
    const { unit, dailyTarget } = shape(
      kind,
      data.unit !== undefined ? data.unit : keep ? current.unit : null,
      data.dailyTarget !== undefined ? data.dailyTarget : keep ? current.dailyTarget : null,
    );

    const changes: Partial<typeof habit.$inferInsert> = { kind, unit, dailyTarget };
    if (data.name !== undefined) changes.name = data.name;
    if (data.weeklyGoal !== undefined) changes.weeklyGoal = data.weeklyGoal;
    if (data.archived === true && current.archivedAt === null) changes.archivedAt = sql`now()` as unknown as Date;
    if (data.archived === false && current.archivedAt !== null) {
      if ((await activeCount(tx, actor)) >= MAX_ACTIVE_HABITS) throw new ConflictError(activeCapMessage);
      changes.archivedAt = null;
      changes.position = await nextPosition(tx, actor);
    }
    const [row] = await tx
      .update(habit)
      .set({ ...changes, updatedAt: nextUpdatedAt() })
      .where(ownedBy(habit, actor, eq(habit.id, habitId)))
      .returning();
    return toHabitView(row);
  });
}

/** Archive (default) or restore a habit without needing its conflict token. Idempotent. */
export async function archiveHabit(actor: Actor, id: string, archived = true): Promise<HabitView> {
  const habitId = parseHabitId(id);
  return db().transaction(async (tx) => {
    await advisoryLock(tx, `habit-write:${actor.id}`);
    const [current] = await tx.select().from(habit).where(ownedBy(habit, actor, eq(habit.id, habitId))).for("update").limit(1);
    if (!current) throw new NotFoundError("Habit not found");
    if ((current.archivedAt !== null) === archived) return toHabitView(current);
    await consumeRate(tx, actor.id, "habit_write", HABIT_WRITES_PER_HOUR, WRITE_LIMIT_MESSAGE);
    const changes: Partial<typeof habit.$inferInsert> = {};
    if (archived) {
      changes.archivedAt = sql`now()` as unknown as Date;
    } else {
      if ((await activeCount(tx, actor)) >= MAX_ACTIVE_HABITS) throw new ConflictError(activeCapMessage);
      changes.archivedAt = null;
      changes.position = await nextPosition(tx, actor);
    }
    const [row] = await tx
      .update(habit)
      .set({ ...changes, updatedAt: nextUpdatedAt() })
      .where(ownedBy(habit, actor, eq(habit.id, habitId)))
      .returning();
    return toHabitView(row);
  });
}

/** Delete a habit and (by cascade) all of its check-ins. */
export async function deleteHabit(actor: Actor, id: string): Promise<void> {
  const habitId = parseHabitId(id);
  await db().transaction(async (tx) => {
    await advisoryLock(tx, `habit-write:${actor.id}`);
    const rows = await tx.delete(habit).where(ownedBy(habit, actor, eq(habit.id, habitId))).returning({ id: habit.id });
    if (rows.length === 0) throw new NotFoundError("Habit not found");
    await consumeRate(tx, actor.id, "habit_write", HABIT_WRITES_PER_HOUR, WRITE_LIMIT_MESSAGE);
  });
}

const reorderSchema = z.object({ ids: z.array(z.uuid()).max(MAX_ACTIVE_HABITS) }).strict();

/**
 * Put the actor's active habits in the given order. `ids` must name exactly the actor's active habits,
 * each once (anything else, another user's habit included, is a 400), so a stale list can't drop one.
 */
export async function reorderHabits(actor: Actor, input: unknown): Promise<HabitView[]> {
  const { ids } = reorderSchema.parse(input);
  return db().transaction(async (tx) => {
    await advisoryLock(tx, `habit-write:${actor.id}`);
    await consumeRate(tx, actor.id, "habit_write", HABIT_WRITES_PER_HOUR, WRITE_LIMIT_MESSAGE);
    const active = await tx.select({ id: habit.id }).from(habit).where(ownedBy(habit, actor, isNull(habit.archivedAt))).for("update");
    const have = new Set(active.map((h) => h.id));
    if (new Set(ids).size !== ids.length || ids.length !== have.size || !ids.every((i) => have.has(i))) {
      throw new BadRequestError("Send every active habit exactly once.");
    }
    for (const [position, habitId] of ids.entries()) {
      // The order is display-only, so it doesn't move the conflict token of an open edit form.
      await tx.update(habit).set({ position }).where(and(ownedBy(habit, actor, eq(habit.id, habitId))));
    }
    const rows = await tx
      .select()
      .from(habit)
      .where(ownedBy(habit, actor, isNull(habit.archivedAt)))
      .orderBy(asc(habit.position), asc(habit.createdAt), asc(habit.id));
    return rows.map(toHabitView);
  });
}
