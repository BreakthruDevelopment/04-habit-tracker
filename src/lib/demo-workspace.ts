import "server-only";
import { randomBytes } from "node:crypto";
import { and, count, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { configuredModel } from "@/lib/ai";
import { demoFixtures } from "@/lib/ai/demo";
import { auth } from "@/lib/auth";
import { type Actor, assertCan } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { DEMO_LOADS_PER_DAY } from "@/lib/domain";
import { DEMO_EMAIL_DOMAIN, MARKER } from "@/lib/demo-identity";
import { demoSeedConfig } from "@/lib/demo-seed-config";
import { ConflictError, TooManyRequestsError } from "@/lib/errors";
import { log } from "@/lib/log";
import { streaks, weekSummary } from "@/lib/progress";
import { addDays, isoWeek, isoWeekday, localToday } from "@/lib/time";
import { reserveDaily } from "@/lib/usage";
import { buildCoachInput, coachInputHash, coachOutputSchema, hasActivity, storedStats, tailorDemo } from "@/lib/weekly-coach";

const PEOPLE = ["Ada", "Ben", "Cleo"] as const;
type Person = (typeof PEOPLE)[number];
const emailFor = (name: Person) => `${name.toLowerCase()}@${DEMO_EMAIL_DOMAIN}`;
const optionsSchema = z.discriminatedUnion("mode", [z.object({ mode: z.literal("admin") }).strict(), z.object({ mode: z.literal("cli") }).strict()]);

/** One admin load per minute and this many per UTC day, for the whole app. */
export { DEMO_LOADS_PER_DAY };

/** Days of history per habit, counting today as day 0: a little over eight weeks. */
export const DEMO_HISTORY_DAYS = 60;

const ZONES: Record<Person, string> = { Ada: "America/Denver", Ben: "Europe/London", Cleo: "Asia/Kolkata" };

type HabitSpec = {
  name: string;
  kind: "check" | "numeric";
  unit?: string;
  target?: number;
  /** Days per week. 7 means a day streak; anything lower means a week streak. */
  goal: number;
  /** Rounding step for numeric values. */
  step?: number;
  /** Chance of a done day on a weekday, and the factor applied on Saturday and Sunday. */
  p: number;
  weekend: number;
  /** Days ago (0 = today), inclusive: forced done (a long streak) or forced missed (a broken one). */
  run?: [number, number];
  miss?: [number, number];
  /** Leave today open, so the Today page always has something to do. */
  openToday?: boolean;
};

const HABITS: Record<Person, HabitSpec[]> = {
  Ada: [
    { name: "Read", kind: "numeric", unit: "pages", target: 20, goal: 5, step: 5, p: 0.8, weekend: 0.6, openToday: true },
    { name: "Guitar practice", kind: "check", goal: 4, p: 0.55, weekend: 1.1 },
    { name: "Stretch", kind: "check", goal: 7, p: 0.85, weekend: 0.9, run: [1, 26], miss: [27, 28] },
    { name: "Glasses of water", kind: "numeric", unit: "glasses", target: 8, goal: 7, step: 1, p: 0.6, weekend: 0.7 },
    { name: "Journal", kind: "check", goal: 3, p: 0.45, weekend: 1.1 },
  ],
  Ben: [
    { name: "Run", kind: "numeric", unit: "km", target: 5, goal: 3, step: 0.5, p: 0.45, weekend: 1.4, openToday: true },
    { name: "Meditate", kind: "check", goal: 7, p: 0.75, weekend: 0.8, miss: [10, 12] },
    { name: "Read", kind: "numeric", unit: "pages", target: 15, goal: 5, step: 5, p: 0.7, weekend: 0.5 },
    { name: "Lights out by 11", kind: "check", goal: 5, p: 0.65, weekend: 0.5 },
  ],
  Cleo: [
    { name: "Spanish practice", kind: "numeric", unit: "min", target: 20, goal: 5, step: 5, p: 0.75, weekend: 0.7, openToday: true },
    { name: "Walk", kind: "numeric", unit: "steps", target: 8000, goal: 6, step: 500, p: 0.7, weekend: 1, miss: [20, 24] },
    { name: "Glasses of water", kind: "numeric", unit: "glasses", target: 8, goal: 7, step: 1, p: 0.6, weekend: 0.8, run: [1, 14] },
    { name: "Journal", kind: "check", goal: 3, p: 0.5, weekend: 1 },
    { name: "Call family", kind: "check", goal: 1, p: 0.5, weekend: 1.2 },
  ],
};

export const DEMO_HABIT_COUNT = Object.values(HABITS).reduce((n, h) => n + h.length, 0);

/** A small seeded PRNG (mulberry32), so the same date range always gives the same data. */
function prng(seedText: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seedText.length; i++) h = Math.imul(h ^ seedText.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Row = { localDate: string; value: string; done: boolean };

const inRange = (n: number, r?: [number, number]) => !!r && n >= r[0] && n <= r[1];
const fmt = (n: number) => String(Math.round(n * 100) / 100);

/** The check-ins for one habit, keyed by the user's local date. Pure: same inputs, same rows. */
export function buildCheckIns(person: Person, index: number, spec: HabitSpec, today: string): Row[] {
  const rand = prng(`${person}:${index}:${spec.name}`);
  const rows: Row[] = [];
  for (let off = DEMO_HISTORY_DAYS - 1; off >= 0; off--) {
    // Three draws per day whatever happens, so one rule changing never shifts the rest of the series.
    const r1 = rand();
    const r2 = rand();
    const r3 = rand();
    const date = addDays(today, -off);
    if (inRange(off, spec.miss)) continue;
    if (off === 0 && spec.openToday) continue;
    const weekend = isoWeekday(date) >= 6;
    const forced = inRange(off, spec.run);
    const done = forced || r1 < spec.p * (weekend ? spec.weekend : 1);
    if (spec.kind === "check") {
      if (done) rows.push({ localDate: date, value: "1", done: true });
      continue;
    }
    const target = spec.target!;
    const step = spec.step ?? 1;
    const snap = (v: number) => Math.round(v / step) * step;
    if (done) {
      rows.push({ localDate: date, value: fmt(Math.max(target, snap(target * (1 + r2 * 0.4)))), done: true });
    } else if (r3 < 0.35) {
      // A partial day: something logged, under the target.
      const v = Math.min(snap(target * (0.3 + r2 * 0.55)), target - step);
      if (v > 0) rows.push({ localDate: date, value: fmt(v), done: false });
    }
  }
  return rows;
}

/** One constant key serializes every demo load and reservation across processes. */
const LOCK_KEY = "demo-load";
const tryLock = (tx: Pick<ReturnType<typeof db>, "execute">) =>
  tx.execute<{ ok: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${LOCK_KEY}, 0)) as ok`);

type Tx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];

/**
 * Atomic global reservation: one load per minute and `DEMO_LOADS_PER_DAY` per UTC day for the whole app. Takes no
 * lock of its own: the caller (`loadDemoWorkspace`) already holds the load lock in this transaction, so the winner of
 * the lock is also the one that reserves, with no gap between the two. A refusal throws and leaves no trace; and if
 * the load later fails, the transaction rolls the reservation back with it.
 */
async function reserveLocked(tx: Tx, actor: Actor): Promise<void> {
  const { rateEvent } = schema;
  const any = eq(rateEvent.kind, "demo_load");
  await tx.delete(rateEvent).where(and(any, sql`${rateEvent.at} <= now() - interval '1 minute'`));
  const [{ n }] = await tx.select({ n: count() }).from(rateEvent).where(and(any, gt(rateEvent.at, sql`now() - interval '1 minute'`)));
  if (n) throw new TooManyRequestsError("Demo workspace can be loaded once per minute. Try again shortly.");
  if (!(await reserveDaily(tx, "demo_load", DEMO_LOADS_PER_DAY))) {
    throw new TooManyRequestsError("The demo workspace was loaded the maximum number of times today. Try again tomorrow.");
  }
  await tx.insert(rateEvent).values({ userId: actor.id, kind: "demo_load" });
}

export type DemoLoadResult = { users: number; habits: number; checkIns: number; coachSummaries: number };

/**
 * Default is the safe admin-route mode. CLI mode independently rechecks all guards.
 * `now` is only for tests; no HTTP input reaches it.
 */
export async function loadDemoWorkspace(
  actor: Actor,
  options: unknown = { mode: "admin" },
  now: Date = new Date(),
  { reserve = false }: { reserve?: boolean } = {},
): Promise<DemoLoadResult> {
  assertCan(actor, "delete");
  const parsed = optionsSchema.parse(options);
  // Hold the lock on a dedicated transaction for the whole load so the CLI and the route cannot
  // interleave. The work itself uses the normal pool. Never wait for it: a second load would sit on
  // a pool connection doing nothing.
  return db().transaction(async (tx) => {
    const [{ ok }] = await tryLock(tx);
    if (!ok) throw new TooManyRequestsError("A demo load is already running. Try again shortly.");
    // The route's reservation happens here, under the same lock, and rolls back with a failed load.
    if (reserve) {
      await reserveLocked(tx, actor);
      log.info("admin.demo_load", { by: actor.id });
    }
    const result = await loadLocked(actor, parsed.mode, now);
    log.info("demo.loaded", { by: actor.id, mode: parsed.mode, ...result });
    return result;
  });
}

async function loadLocked(actor: Actor, mode: "admin" | "cli", now: Date): Promise<DemoLoadResult> {
  const password = mode === "cli" ? demoSeedConfig().password : undefined;
  const api = auth();
  const ctx = await api.$context;
  const people = new Map<Person, Actor>();

  // Preflight all identities before changing anything. An existing unrelated account at a demo
  // address must never be adopted or have its habits/password replaced.
  for (const name of PEOPLE) {
    const [existing] = await db().select().from(schema.user).where(eq(schema.user.email, emailFor(name)));
    if (existing && existing.image !== MARKER) throw new ConflictError("A demo email belongs to an unrelated account; no demo data was replaced.");
    if (existing?.id === actor.id) throw new ConflictError("Load the demo from a separate administrator account.");
  }

  for (const name of PEOPLE) {
    const email = emailFor(name);
    const role = mode === "cli" && name === "Ada" ? "admin" : "user";
    const secret = password ?? randomBytes(32).toString("base64url");
    const [existing] = await db().select().from(schema.user).where(eq(schema.user.email, email));
    let id: string;
    if (existing) {
      id = existing.id;
      // Use Better Auth's adapter and hasher, preserving its password format and hooks. Rotate even
      // on reload, so a previous CLI password cannot sign in on live.
      await ctx.internalAdapter.updateUser(id, { role });
      await ctx.internalAdapter.updatePassword(id, await ctx.password.hash(secret));
      await ctx.internalAdapter.deleteUserSessions(id);
    } else {
      const created = await api.api.createUser({ body: { email, name, password: secret, role, data: { image: MARKER } } });
      id = created.user.id;
    }
    people.set(name, { id, role: role === "admin" ? "admin" : "user" });
  }
  const ids = [...people.values()].map((p) => p.id);

  // Replace only the demo users' data, in one transaction. The ids come from the marker-checked accounts
  // above, never from a name, an email suffix or a SQL predicate. Demo users never get push devices, and any
  // that exist (a demo user who subscribed) are removed, so no reminder is ever sent to a made-up user.
  let habits = 0;
  let checkIns = 0;
  await db().transaction(async (tx) => {
    await tx.delete(schema.rateEvent).where(and(inArray(schema.rateEvent.userId, ids), sql`${schema.rateEvent.kind} <> 'demo_load'`));
    await tx.delete(schema.pushSubscription).where(inArray(schema.pushSubscription.userId, ids));
    await tx.delete(schema.coachClaim).where(inArray(schema.coachClaim.userId, ids));
    await tx.delete(schema.coachSummary).where(inArray(schema.coachSummary.userId, ids));
    await tx.delete(schema.habit).where(inArray(schema.habit.ownerId, ids)); // check-ins cascade

    // Habits "were created" a little before the first check-in, so the heatmap counts them from the start.
    const created = new Date(now.getTime() - (DEMO_HISTORY_DAYS + 2) * 24 * 60 * 60 * 1000);
    for (const name of PEOPLE) {
      const owner = people.get(name)!;
      const tz = ZONES[name];
      const today = localToday(tz, now);
      await tx
        .insert(schema.userSettings)
        .values({ userId: owner.id, timeZone: tz, reminderTime: null, lastReminderOn: null, lastReminderAt: null })
        .onConflictDoUpdate({
          target: schema.userSettings.userId,
          set: { timeZone: tz, reminderTime: null, lastReminderOn: null, lastReminderAt: null, updatedAt: sql`now()` },
        });
      const specs = HABITS[name];
      for (let i = 0; i < specs.length; i++) {
        const s = specs[i];
        const [row] = await tx
          .insert(schema.habit)
          .values({
            ownerId: owner.id,
            name: s.name,
            kind: s.kind,
            unit: s.kind === "numeric" ? s.unit! : null,
            dailyTarget: s.kind === "numeric" ? String(s.target) : null,
            weeklyGoal: s.goal,
            position: i,
            createdAt: created,
            updatedAt: created,
          })
          .returning({ id: schema.habit.id });
        habits += 1;
        const rows = buildCheckIns(name, i, s, today).map((r) => ({ habitId: row.id, ownerId: owner.id, ...r }));
        for (let at = 0; at < rows.length; at += 500) await tx.insert(schema.checkIn).values(rows.slice(at, at + 500));
        checkIns += rows.length;
      }
    }
  });

  // The last-week summary per user: built from their real numbers with no model call (mode `demo`, no calls
  // counted). The hash is the one `coach.ts` computes for this data under the configured model, so with
  // `AI_PROVIDER=demo` a refresh finds it current and returns it without spending anything; under a live provider
  // the hash differs and a refresh simply makes the first real call. Reads go through the pool, so this runs
  // after the data above has committed.
  let coachSummaries = 0;
  const model = configuredModel();
  const fixture = coachOutputSchema.parse(demoFixtures["weekly-coach"]);
  for (const name of PEOPLE) {
    const owner = people.get(name)!;
    // One user's summary failing must not undo the rest of a load that already committed. Log the name of the
    // error only: a database error's message carries the query and its parameters.
    try {
      const lastWeek = isoWeek(addDays(localToday(ZONES[name], now), -7));
      const input = buildCoachInput(await weekSummary(owner, lastWeek, now), await streaks(owner, now));
      if (!hasActivity(input)) continue;
      await db().insert(schema.coachSummary).values({
        userId: owner.id,
        isoWeek: lastWeek,
        data: coachOutputSchema.parse(tailorDemo(fixture, input)),
        stats: storedStats(input),
        mode: "demo",
        inputHash: coachInputHash(input, model),
        regenerations: 0,
        modelCalls: 0,
      });
      coachSummaries += 1;
    } catch (err) {
      log.error("demo.coach_seed_failed", { person: name, errorName: err instanceof Error ? err.name : typeof err });
    }
  }
  return { users: people.size, habits, checkIns, coachSummaries };
}
