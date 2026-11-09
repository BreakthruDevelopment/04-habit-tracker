import "server-only";
import { and, asc, between, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { type Actor, ForbiddenError } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { DEMO_LOADS_PER_DAY, HEATMAP_DAYS, HEATMAP_MAX_DAYS, PROGRESS_WEEKS, STREAK_LOOKBACK_DAYS } from "@/lib/domain";
import { env } from "@/lib/env";
import { BadRequestError } from "@/lib/errors";
import { type HabitView, getHabit, parseHabitId, toHabitView, trimNumeric } from "@/lib/habits";
import { ownedBy } from "@/lib/owned";
import { getLocalDay } from "@/lib/settings";
import { addDays, daysBetween, isoWeek, parseIsoWeek, shiftIsoWeek, weekBounds, weekIndex, weekStart } from "@/lib/time";

const { habit, checkIn } = schema;

// ---------------------------------------------------------------------------
// Streaks
// ---------------------------------------------------------------------------

/**
 * Which kind of streak a habit has follows its *current* weekly goal, and past check-ins are never rewritten. So
 * changing the goal re-evaluates all past weeks (a week "met" at goal 3 may not be at 5) and switches the habit
 * between day mode (goal 7) and week mode (goal under 7); the streak shown changes with it.
 *
 * `day`: consecutive done days (habits with a weekly goal of 7). `week`: consecutive ISO weeks that met the goal
 * (goal under 7). `current` ends today (or yesterday while today is still open) for `day`, and this week (or last
 * week while this one isn't met yet) for `week`. `best` is the longest run in the last 400 days.
 */
export type Streak = { mode: "day" | "week"; current: number; best: number };

/**
 * Gaps and islands over the last 400 days, one query. Day islands: `date - row_number()` is constant inside a run
 * of consecutive dates. Week islands use a continuous week index, `(Monday - 2001-01-01) / 7`, which goes up by one
 * across year ends (2026-W53 to 2027-W01), unlike the week number, which resets. Exported so tests can EXPLAIN it.
 */
export function streakIslandsQuery(userId: string, from: string, habitId?: string, includeArchived = false) {
  const only = habitId ? sql`and h.id = ${habitId}::uuid` : sql``;
  const live = includeArchived ? sql`` : sql`and h.archived_at is null`;
  return sql`
    select habit_id::text as "habitId", mode, max(idx)::int as "endIdx", count(*)::int as len from (
      select habit_id, mode, idx, idx - row_number() over (partition by habit_id, mode order by idx)::int as grp from (
        select c.habit_id, 'day' as mode, (c.local_date - date '1970-01-01') as idx
        from check_in c join habit h on h.id = c.habit_id and h.owner_id = c.owner_id
        where c.owner_id = ${userId} and c.local_date >= ${from}::date and c.done
          ${live} and h.weekly_goal = 7 ${only}
        union all
        select c.habit_id, 'week' as mode, ((date_trunc('week', c.local_date)::date - date '2001-01-01') / 7) as idx
        from check_in c join habit h on h.id = c.habit_id and h.owner_id = c.owner_id
        where c.owner_id = ${userId} and c.local_date >= ${from}::date and c.done
          ${live} and h.weekly_goal < 7 ${only}
        group by c.habit_id, idx, h.weekly_goal
        having count(*) >= h.weekly_goal
      ) runs
    ) islands
    group by habit_id, mode, grp
  `;
}

type Island = { habitId: string; mode: "day" | "week"; endIdx: number; len: number };

/** Streaks for the actor's active habits (or just `habitId`), as of local date `today`. */
async function computeStreaks(userId: string, today: string, habitId?: string, includeArchived = false): Promise<Map<string, Streak>> {
  const from = weekStart(addDays(today, -STREAK_LOOKBACK_DAYS));
  const rows = (await db().execute(streakIslandsQuery(userId, from, habitId, includeArchived))) as unknown as Island[];
  const dayNow = daysBetween("1970-01-01", today);
  const weekNow = weekIndex(today);
  const out = new Map<string, Streak>();
  for (const r of rows) {
    const s = out.get(r.habitId) ?? { mode: r.mode, current: 0, best: 0 };
    s.best = Math.max(s.best, r.len);
    // Ending today or yesterday (this week or last) keeps the run alive.
    // A check-in dated after today (the user moved west) can leave two runs that both count as live:
    // take the longer, so the answer doesn't depend on row order.
    if (r.endIdx >= (r.mode === "day" ? dayNow : weekNow) - 1) s.current = Math.max(s.current, r.len);
    out.set(r.habitId, s);
  }
  return out;
}

const noStreak = (h: { weeklyGoal: number }): Streak => ({ mode: h.weeklyGoal === 7 ? "day" : "week", current: 0, best: 0 });

/** Streaks of the actor's active habits, keyed by habit id. */
export async function streaks(actor: Actor, now: Date = new Date()): Promise<Record<string, Streak>> {
  const { today } = await getLocalDay(actor, now);
  const found = await computeStreaks(actor.id, today);
  const active = await db().select().from(habit).where(ownedBy(habit, actor, isNull(habit.archivedAt)));
  return Object.fromEntries(active.map((h) => [h.id, found.get(h.id) ?? noStreak(h)]));
}

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

export type WeekDot = { date: string; done: boolean; value: string | null };

export type TodayHabit = HabitView & {
  value: string | null;
  done: boolean;
  streak: Streak;
  week: { dots: WeekDot[]; doneDays: number; goalMet: boolean };
};

export type TodayView = {
  date: string;
  week: string;
  timeZone: string;
  total: number;
  doneCount: number;
  habits: TodayHabit[];
};

/** Everything the Today page needs: each active habit with today's value, its streak and this week's dots. */
export async function today(actor: Actor, now: Date = new Date()): Promise<TodayView> {
  const { timeZone, today: date } = await getLocalDay(actor, now);
  const { monday, sunday } = weekBounds(date);
  const [habits, rows, streakMap] = await Promise.all([
    db()
      .select()
      .from(habit)
      .where(ownedBy(habit, actor, isNull(habit.archivedAt)))
      .orderBy(asc(habit.position), asc(habit.createdAt), asc(habit.id)),
    // owner_id plus a local_date range: the covering index.
    db()
      .select({ habitId: checkIn.habitId, date: checkIn.localDate, done: checkIn.done, value: checkIn.value })
      .from(checkIn)
      .where(ownedBy(checkIn, actor, between(checkIn.localDate, monday, sunday))),
    computeStreaks(actor.id, date),
  ]);
  const byHabit = new Map<string, Map<string, (typeof rows)[number]>>();
  for (const r of rows) {
    const m = byHabit.get(r.habitId) ?? new Map();
    m.set(r.date, r);
    byHabit.set(r.habitId, m);
  }
  const result = habits.map((h): TodayHabit => {
    const mine = byHabit.get(h.id);
    const dots: WeekDot[] = Array.from({ length: 7 }, (_, i) => {
      const d = addDays(monday, i);
      const r = mine?.get(d);
      return { date: d, done: r?.done ?? false, value: r ? trimNumeric(r.value) : null };
    });
    const doneDays = dots.filter((d) => d.done).length;
    const mineToday = mine?.get(date);
    return {
      ...toHabitView(h),
      value: mineToday ? trimNumeric(mineToday.value) : null,
      done: mineToday?.done ?? false,
      streak: streakMap.get(h.id) ?? noStreak(h),
      week: { dots, doneDays, goalMet: doneDays >= h.weeklyGoal },
    };
  });
  return { date, week: isoWeek(date), timeZone, total: result.length, doneCount: result.filter((h) => h.done).length, habits: result };
}

// ---------------------------------------------------------------------------
// Week summary
// ---------------------------------------------------------------------------

export type WeekHabit = {
  habitId: string;
  name: string;
  kind: HabitView["kind"];
  unit: string | null;
  dailyTarget: string | null;
  weeklyGoal: number;
  doneDays: number;
  total: string;
  /** Seven entries, Monday to Sunday: the value saved that day, or null. */
  values: (string | null)[];
  /** Seven entries, Monday to Sunday: the `done` flag stored with that day's check-in (fixed when it was written). */
  done: boolean[];
  goalMet: boolean;
  lastWeekDoneDays: number;
};

export type WeekSummary = {
  week: string;
  monday: string;
  sunday: string;
  /** Neighbouring weeks, or null at the ends of the 52-week window. They round-trip through `?week=`. */
  prev: string | null;
  next: string | null;
  isCurrent: boolean;
  /** 1 to 7: days of this week that have happened (7 for past weeks). */
  daysElapsed: number;
  habits: WeekHabit[];
  totals: { habits: number; habitsOnGoal: number; doneCheckIns: number; completionPct: number };
};

/**
 * The per-habit week query: one scan of `check_in` over last week and this week through the covering index
 * (`owner_id` plus a `local_date` range), grouped by habit. Exported so tests can EXPLAIN it.
 */
export function weekQuery(userId: string, timeZone: string, monday: string, sunday: string) {
  const prevMonday = addDays(monday, -7);
  const inWeek = sql`c.local_date between ${monday}::date and ${sunday}::date`;
  const inPrev = sql`c.local_date between ${prevMonday}::date and ${addDays(sunday, -7)}::date`;
  return sql`
    select h.id::text as "habitId", h.name, h.kind, h.unit, h.daily_target::text as "dailyTarget",
      h.weekly_goal::int as "weeklyGoal",
      (count(c.local_date) filter (where c.done and ${inWeek}))::int as "doneDays",
      coalesce(sum(c.value) filter (where ${inWeek}), 0)::text as total,
      (count(c.local_date) filter (where c.done and ${inPrev}))::int as "lastWeekDoneDays",
      coalesce(jsonb_object_agg(c.local_date::text, c.value::text) filter (where ${inWeek}), '{}'::jsonb) as "values",
      coalesce(jsonb_object_agg(c.local_date::text, c.done) filter (where ${inWeek}), '{}'::jsonb) as "doneFlags"
    from habit h
    left join check_in c on c.habit_id = h.id and c.owner_id = h.owner_id
      and c.owner_id = ${userId} and c.local_date between ${prevMonday}::date and ${sunday}::date
    where h.owner_id = ${userId}
      and (h.created_at at time zone ${timeZone})::date <= ${sunday}::date
      and (h.archived_at is null or (h.archived_at at time zone ${timeZone})::date >= ${monday}::date)
    group by h.id
    order by h.position, h.created_at, h.id
  `;
}

type WeekRow = Omit<WeekHabit, "values" | "done" | "goalMet"> & { values: Record<string, string>; doneFlags: Record<string, boolean> };

/**
 * One ISO week (`YYYY-Www`, ISO week-year) for the actor's habits. The label must be a real week, no later than
 * the current week and within the last 52 weeks; otherwise 400.
 */
export async function weekSummary(actor: Actor, weekLabel?: string | null, now: Date = new Date()): Promise<WeekSummary> {
  const { timeZone, today: date } = await getLocalDay(actor, now);
  const currentWeek = isoWeek(date);
  const week = weekLabel || currentWeek; // an empty ?week= means "this week"
  const monday = parseIsoWeek(week); // 400 for a week that doesn't exist, e.g. 2027-W53
  const age = weekIndex(date) - weekIndex(monday);
  if (age < 0 || age > PROGRESS_WEEKS - 1) {
    throw new BadRequestError(`Choose the current week or one of the previous ${PROGRESS_WEEKS - 1}.`);
  }
  const sunday = addDays(monday, 6);
  const rows = (await db().execute(weekQuery(actor.id, timeZone, monday, sunday))) as unknown as WeekRow[];
  const habits = rows.map(({ doneFlags, ...r }): WeekHabit => ({
    ...r,
    dailyTarget: r.dailyTarget === null ? null : trimNumeric(r.dailyTarget),
    total: trimNumeric(r.total),
    values: Array.from({ length: 7 }, (_, i) => {
      const v = r.values[addDays(monday, i)];
      return v === undefined ? null : trimNumeric(v);
    }),
    done: Array.from({ length: 7 }, (_, i) => doneFlags[addDays(monday, i)] === true),
    goalMet: r.doneDays >= r.weeklyGoal,
  }));
  const goalSum = habits.reduce((n, h) => n + h.weeklyGoal, 0);
  const counted = habits.reduce((n, h) => n + Math.min(h.doneDays, h.weeklyGoal), 0);
  return {
    week,
    monday,
    sunday,
    prev: age < PROGRESS_WEEKS - 1 ? shiftIsoWeek(week, -1) : null,
    next: age > 0 ? shiftIsoWeek(week, 1) : null,
    isCurrent: age === 0,
    daysElapsed: age === 0 ? daysBetween(monday, date) + 1 : 7,
    habits,
    totals: {
      habits: habits.length,
      habitsOnGoal: habits.filter((h) => h.goalMet).length,
      doneCheckIns: habits.reduce((n, h) => n + h.doneDays, 0),
      completionPct: goalSum === 0 ? 0 : Math.round((100 * counted) / goalSum),
    },
  };
}

// ---------------------------------------------------------------------------
// Heatmap
// ---------------------------------------------------------------------------

export type HeatmapDay = { date: string; done: number; total: number; intensity: 0 | 1 | 2 | 3 | 4; value?: string | null };
export type Heatmap = { from: string; to: string; habitId: string | null; days: HeatmapDay[] };

const heatmapOptsSchema = z.object({ days: z.coerce.number().int().min(1).max(HEATMAP_MAX_DAYS).default(HEATMAP_DAYS), habitId: z.string().optional() });

/** 0 for nothing; otherwise 1 to 4 by the share of habits done (4 = all of them). */
export function intensityOf(done: number, total: number): HeatmapDay["intensity"] {
  if (done <= 0) return 0;
  const r = Math.min(1, done / Math.max(total, done));
  return r >= 1 ? 4 : r >= 0.75 ? 3 : r >= 0.5 ? 2 : 1;
}

/** Across all habits: per day, check-ins done over the habits that existed that day. Index-only scan of the covering index. */
export function heatmapQuery(userId: string, timeZone: string, from: string, to: string) {
  return sql`
    select d::date::text as date, coalesce(c.n, 0)::int as done,
      (select count(*) from habit h where h.owner_id = ${userId}
         and (h.created_at at time zone ${timeZone})::date <= d::date
         and (h.archived_at is null or (h.archived_at at time zone ${timeZone})::date >= d::date))::int as total
    from generate_series(${from}::date, ${to}::date, interval '1 day') d
    left join (
      select local_date, count(*) filter (where done) as n from check_in
      where owner_id = ${userId} and local_date between ${from}::date and ${to}::date
      group by local_date
    ) c on c.local_date = d::date
    order by d
  `;
}

/** One habit's own rows over the same window, by its primary key. */
export function habitHeatmapQuery(userId: string, habitId: string, from: string, to: string) {
  return sql`
    select local_date::text as date, done, value::text as value from check_in
    where owner_id = ${userId} and habit_id = ${habitId}::uuid and local_date between ${from}::date and ${to}::date
    order by local_date
  `;
}

/**
 * The last `days` (default 30) local days ending today. With `habitId` (which must be the actor's, else 404) it is
 * that habit alone: `done` is 1 or 0 and `value` is what was saved.
 */
export async function heatmap(actor: Actor, opts: { days?: unknown; habitId?: string | null } = {}, now: Date = new Date()): Promise<Heatmap> {
  const { days } = heatmapOptsSchema.parse({ days: opts.days === "" ? undefined : (opts.days ?? undefined) });
  const { timeZone, today: to } = await getLocalDay(actor, now);
  const from = addDays(to, -(days - 1));
  if (opts.habitId) {
    const h = await getHabit(actor, opts.habitId);
    const rows = (await db().execute(habitHeatmapQuery(actor.id, h.id, from, to))) as unknown as { date: string; done: boolean; value: string }[];
    const byDate = new Map(rows.map((r) => [r.date, r]));
    const target = h.dailyTarget === null ? null : Number(h.dailyTarget);
    return {
      from,
      to,
      habitId: h.id,
      days: Array.from({ length: days }, (_, i): HeatmapDay => {
        const date = addDays(from, i);
        const r = byDate.get(date);
        if (!r) return { date, done: 0, total: 1, intensity: 0, value: null };
        // Done is 4. Not done (a numeric habit short of its target) is 1 to 3 by how far along it was.
        const frac = target ? Number(r.value) / target : 0;
        const intensity = r.done ? 4 : frac >= 2 / 3 ? 3 : frac >= 1 / 3 ? 2 : 1;
        return { date, done: r.done ? 1 : 0, total: 1, intensity, value: trimNumeric(r.value) };
      }),
    };
  }
  const rows = (await db().execute(heatmapQuery(actor.id, timeZone, from, to))) as unknown as { date: string; done: number; total: number }[];
  return {
    from,
    to,
    habitId: null,
    // A check-in backfilled to before its habit's creation day can outnumber that day's habits: never above 100%.
    days: rows.map((r) => {
      const total = Math.max(r.total, r.done);
      return { date: r.date, done: r.done, total, intensity: intensityOf(r.done, total) };
    }),
  };
}

// ---------------------------------------------------------------------------
// One habit's detail
// ---------------------------------------------------------------------------

export type HabitProgress = {
  habit: HabitView;
  streak: Streak;
  /** The last 8 ISO weeks, oldest first, each with its done days and whether it met the goal. */
  weeks: { week: string; monday: string; doneDays: number; goalMet: boolean }[];
  hitRate: number;
  /** Today and the 7 days before it (the editable window), newest first. */
  recent: { date: string; value: string | null; done: boolean }[];
};

/** Streaks, the goal hit rate over 8 weeks and the editable days for one of the actor's habits (404 otherwise). */
export async function habitProgress(actor: Actor, habitId: string, now: Date = new Date()): Promise<HabitProgress> {
  const h = await getHabit(actor, parseHabitId(habitId));
  const { today: date } = await getLocalDay(actor, now);
  const firstMonday = addDays(weekBounds(date).monday, -7 * 7);
  const [streakMap, rows] = await Promise.all([
    computeStreaks(actor.id, date, h.id, true), // an archived habit keeps its real history
    db()
      .select({ date: checkIn.localDate, done: checkIn.done, value: checkIn.value })
      .from(checkIn)
      .where(ownedBy(checkIn, actor, and(eq(checkIn.habitId, h.id), between(checkIn.localDate, firstMonday, date)))),
  ]);
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const weeks = Array.from({ length: 8 }, (_, i) => {
    const monday = addDays(firstMonday, i * 7);
    let doneDays = 0;
    for (let d = 0; d < 7; d++) if (byDate.get(addDays(monday, d))?.done) doneDays++;
    return { week: isoWeek(monday), monday, doneDays, goalMet: doneDays >= h.weeklyGoal };
  });
  return {
    habit: h,
    streak: streakMap.get(h.id) ?? noStreak(h),
    weeks,
    hitRate: weeks.filter((w) => w.goalMet).length / weeks.length,
    recent: Array.from({ length: 8 }, (_, i) => {
      const d = addDays(date, -i);
      const r = byDate.get(d);
      return { date: d, value: r ? trimNumeric(r.value) : null, done: r?.done ?? false };
    }),
  };
}

// ---------------------------------------------------------------------------
// Admin counts
// ---------------------------------------------------------------------------

export type AdminCounts = {
  users: number;
  activeHabits: number;
  checkInsToday: number;
  checkInsLast7Days: number;
  pushDevices: number;
  remindersSentToday: number;
  coachSummariesThisWeek: { live: number; demo: number; skipped: number; fallback: number };
  usage: { kind: "push" | "coach" | "demo_load"; used: number; cap: number | null }[];
};

/**
 * Aggregate numbers for the admin page: counts only, never a row, a name or an email. "Today" is the UTC date
 * (users' local dates span two calendar dates at any instant). Admin only.
 */
export async function adminCounts(actor: Actor): Promise<AdminCounts> {
  if (actor.role !== "admin") throw new ForbiddenError();
  const rows = await db().execute<Record<string, number>>(sql`
    select
      (select count(*) from "user")::int as users,
      (select count(*) from habit where archived_at is null)::int as "activeHabits",
      (select count(*) from check_in where local_date = (now() at time zone 'utc')::date)::int as "checkInsToday" /* UTC date, served by check_in_local_date_idx */,
      (select count(*) from check_in where local_date between (now() at time zone 'utc')::date - 6 and (now() at time zone 'utc')::date)::int as "checkInsLast7Days",
      (select count(*) from push_subscription)::int as "pushDevices",
      coalesce((select count from daily_usage where day = (now() at time zone 'utc')::date and kind = 'push'), 0)::int as "remindersSentToday",
      coalesce((select count from daily_usage where day = (now() at time zone 'utc')::date and kind = 'coach'), 0)::int as "coachUsed",
      coalesce((select count from daily_usage where day = (now() at time zone 'utc')::date and kind = 'demo_load'), 0)::int as "demoUsed",
      (select count(*) from coach_summary where mode = 'live' and generated_at >= date_trunc('week', now()))::int as "coachLive",
      (select count(*) from coach_summary where mode = 'demo' and generated_at >= date_trunc('week', now()))::int as "coachDemo",
      (select count(*) from coach_summary where mode = 'skipped' and generated_at >= date_trunc('week', now()))::int as "coachSkipped",
      (select count(*) from coach_summary where mode = 'fallback' and generated_at >= date_trunc('week', now()))::int as "coachFallback"
  `);
  const r = rows[0];
  const e = env();
  return {
    users: r.users,
    activeHabits: r.activeHabits,
    checkInsToday: r.checkInsToday,
    checkInsLast7Days: r.checkInsLast7Days,
    pushDevices: r.pushDevices,
    remindersSentToday: r.remindersSentToday,
    coachSummariesThisWeek: { live: r.coachLive, demo: r.coachDemo, skipped: r.coachSkipped, fallback: r.coachFallback },
    usage: [
      { kind: "push", used: r.remindersSentToday, cap: e.PUSH_DAILY_CAP },
      { kind: "coach", used: r.coachUsed, cap: e.COACH_DAILY_CAP },
      { kind: "demo_load", used: r.demoUsed, cap: DEMO_LOADS_PER_DAY },
    ],
  };
}
