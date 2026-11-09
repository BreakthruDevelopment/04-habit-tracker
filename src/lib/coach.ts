import "server-only";
import { eq, inArray, sql } from "drizzle-orm";
import { ZodError, z } from "zod";
import { configuredModel } from "@/lib/ai";
import { AiError } from "@/lib/ai/types";
import { type Actor, ForbiddenError, UnauthorizedError, assertCan } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { COACH_CALLS_PER_HOUR, COACH_MAX_REFRESHES } from "@/lib/domain";
import { env } from "@/lib/env";
import { BadRequestError, HttpError, TooManyRequestsError } from "@/lib/errors";
import { log } from "@/lib/log";
import { ownedBy } from "@/lib/owned";
import { streaks, weekSummary } from "@/lib/progress";
import { getLocalDay } from "@/lib/settings";
import { isoWeek, parseIsoWeek, weekIndex } from "@/lib/time";
import { advisoryLock, consumeRate, reserveDaily } from "@/lib/usage";
import {
  type CoachMode,
  type CoachOutput,
  type StoredStats,
  buildCoachInput,
  buildCoachPrompt,
  coachInputHash,
  composeCoach,
  hasActivity,
  storedStats,
} from "@/lib/weekly-coach";

const { coachSummary, habit } = schema;

export const REFRESH_CAP_MESSAGE = "This week's summary has been refreshed twice; it updates next week";
export const HOURLY_CAP_MESSAGE = "You've asked the coach for a lot of summaries this hour. Try again later.";
export const DAILY_CAP_MESSAGE = "The coach has reached its daily limit for everyone. Try again tomorrow.";

export const coachRequestSchema = z.object({ week: z.string().max(16).optional() }).strict();

// ---------------------------------------------------------------------------
// What the API returns
// ---------------------------------------------------------------------------

/** A habit reference in the text: the H-id the model used, and what it is now (null if it was deleted since). */
export type CoachItem = { habit: string; habitId: string | null; habitName: string | null; text: string };

export type CoachStatsView = Omit<StoredStats, "habits"> & {
  habits: (StoredStats["habits"][number] & { name: string | null; unit: string | null })[];
};

export type CoachSummaryView = {
  data: Omit<CoachOutput, "wins" | "focus"> & { wins: CoachItem[]; focus: CoachItem[] };
  /** The real numbers behind the text, to show beside it. */
  stats: CoachStatsView;
  mode: CoachMode;
  generatedAt: string;
};

export type CoachView = {
  week: string;
  /** Null until a summary has been generated for the week. */
  summary: CoachSummaryView | null;
  /** Regenerations left for this week (0 to 2). Unchanged data never uses one. */
  refreshesLeft: number;
};

/** A 429 that carries the cached summary, so the UI can keep showing it. */
export class CoachLimitError extends TooManyRequestsError {
  constructor(
    message: string,
    readonly reason: "refresh_cap" | "hourly" | "daily_cap",
    public view: CoachView | null = null,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Errors: nothing from a database error may reach a log line
// ---------------------------------------------------------------------------

/**
 * Drizzle and postgres.js errors carry the query and its parameters in `message`, and a coach query's
 * parameters can hold the summary text, which may repeat a habit name. `errorResponse` logs `err.message` for
 * anything it doesn't recognise, so unknown errors are logged here, as a name and a Postgres code only, and
 * replaced by a plain 500 `HttpError` (which `errorResponse` does not log).
 */
function scrub(err: unknown, phase: string): never {
  if (
    err instanceof HttpError ||
    err instanceof AiError ||
    err instanceof ZodError ||
    err instanceof UnauthorizedError ||
    err instanceof ForbiddenError
  ) {
    throw err;
  }
  const code = (err as { code?: unknown; cause?: { code?: unknown } } | null)?.cause?.code ?? (err as { code?: unknown } | null)?.code;
  log.error("coach.failed", {
    phase,
    errorName: err instanceof Error ? err.name : typeof err,
    ...(typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? { pgCode: code } : {}),
  });
  throw new HttpError(500, "The coach couldn't build your summary just now. Try again in a moment.");
}

// ---------------------------------------------------------------------------
// Weeks
// ---------------------------------------------------------------------------

/** This week (default) or last week in the user's time zone; anything else is a 400. */
async function resolveWeek(actor: Actor, label: string | null | undefined, now: Date): Promise<string> {
  const { today } = await getLocalDay(actor, now);
  const week = label || isoWeek(today);
  const monday = parseIsoWeek(week); // 400 for a week that doesn't exist
  const age = weekIndex(today) - weekIndex(monday);
  if (age < 0 || age > 1) throw new BadRequestError("The coach covers this week and last week.");
  return week;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

type Row = typeof coachSummary.$inferSelect;

async function toView(actor: Actor, week: string, row: Row | undefined): Promise<CoachView> {
  if (!row) return { week, summary: null, refreshesLeft: COACH_MAX_REFRESHES };
  const stats = row.stats as StoredStats;
  const ids = stats.habits.map((h) => h.habitId);
  const names = new Map<string, { name: string; unit: string | null }>();
  if (ids.length) {
    const rows = await db()
      .select({ id: habit.id, name: habit.name, unit: habit.unit })
      .from(habit)
      .where(ownedBy(habit, actor, inArray(habit.id, ids)));
    for (const r of rows) names.set(r.id, r);
  }
  const byHid = new Map(stats.habits.map((h) => [h.id, h]));
  const item = (i: CoachOutput["wins"][number]): CoachItem => {
    const s = byHid.get(i.habit);
    return { habit: i.habit, habitId: s?.habitId ?? null, habitName: s ? (names.get(s.habitId)?.name ?? null) : null, text: i.text };
  };
  const data = row.data as CoachOutput;
  return {
    week,
    summary: {
      data: { ...data, wins: data.wins.map(item), focus: data.focus.map(item) },
      stats: {
        ...stats,
        habits: stats.habits.map((h) => ({ ...h, name: names.get(h.habitId)?.name ?? null, unit: names.get(h.habitId)?.unit ?? null })),
      },
      mode: row.mode,
      generatedAt: row.generatedAt.toISOString(),
    },
    refreshesLeft: Math.max(0, COACH_MAX_REFRESHES - row.regenerations),
  };
}

/** The cached summary for a week, or `summary: null`. Never calls the model. Own data only. */
export async function getCoach(actor: Actor, label?: string | null, now: Date = new Date()): Promise<CoachView> {
  assertCan(actor, "read", { ownerId: actor.id });
  try {
    const week = await resolveWeek(actor, label, now);
    const [row] = await db().select().from(coachSummary).where(ownedBy(coachSummary, actor, eq(coachSummary.isoWeek, week)));
    return await toView(actor, week, row);
  } catch (err) {
    return scrub(err, "get");
  }
}

// ---------------------------------------------------------------------------
// Generating
// ---------------------------------------------------------------------------

export type CoachGenerateResult = CoachView & {
  /** True when the stored summary was returned and no model call was made. */
  cached: boolean;
};

/** Concurrent requests for the same user and week in this process share one run (the advisory lock covers other processes). */
const inflight = new Map<string, Promise<CoachGenerateResult>>();

/**
 * Generate (or regenerate) the summary for this week or last week.
 *
 * Under an advisory lock on (user, week): the same input hash returns the stored row with no call; a week with
 * no check-ins stores the fixed fresh-start message with no call; changed data regenerates up to twice
 * (`REFRESH_CAP_MESSAGE` after that); every real call spends one of the user's 6 per hour and one of the app's
 * `COACH_DAILY_CAP` per day, both inside the same transaction, so a race can't overshoot either.
 * A provider outage throws the `AiError` (502 or 429) and stores nothing; the attempt still counts.
 */
export async function generateCoach(actor: Actor, label?: string | null, now: Date = new Date()): Promise<CoachGenerateResult> {
  assertCan(actor, "create");
  try {
    const week = await resolveWeek(actor, label, now);
    const key = `${actor.id}:${week}`;
    const running = inflight.get(key);
    if (running) return await running;
    const run = runGenerate(actor, week, now).finally(() => inflight.delete(key));
    inflight.set(key, run);
    return await run;
  } catch (err) {
    if (err instanceof CoachLimitError) throw err;
    return scrub(err, "generate");
  }
}

/**
 * At most this many summaries are being generated in one process at a time. Each holds a pooled connection (the
 * transaction, and its advisory lock, stay open during the model call), and the pool has 5; the rest of the app
 * must keep getting connections while the model thinks.
 */
const MAX_CONCURRENT_RUNS = 2;
let active = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT_RUNS) await new Promise<void>((resolve) => waiting.push(resolve));
  else active += 1;
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next(); // hand the slot straight over
    else active -= 1;
  }
}

async function runGenerate(actor: Actor, week: string, now: Date): Promise<CoachGenerateResult> {
  const e = env();
  // Set inside the transaction; read after it commits. (A holder object, so TypeScript doesn't narrow them away.)
  const flags: { providerError?: AiError; limit?: CoachLimitError } = {};

  // Read the stats before the transaction: it holds one of the pool's few connections, and a query inside it that
  // needs another one would deadlock the pool once enough requests arrived together.
  const summary = await weekSummary(actor, week, now);
  const input = buildCoachInput(summary, await streaks(actor, now));
  const model = configuredModel();
  const inputHash = coachInputHash(buildCoachPrompt(input).statsJson, model);

  let outcome: { row: Row | undefined; cached: boolean };
  try {
    outcome = await withSlot(transact);
  } catch (err) {
    // A cap thrown inside the transaction (it rolled back, so nothing was spent) still gets the cached summary attached.
    if (err instanceof CoachLimitError && !err.view) {
      const [row] = await db().select().from(coachSummary).where(ownedBy(coachSummary, actor, eq(coachSummary.isoWeek, week)));
      err.view = await toView(actor, week, row);
    }
    throw err;
  }

  if (flags.providerError) throw flags.providerError;
  if (flags.limit) {
    flags.limit.view = await toView(actor, week, outcome.row);
    throw flags.limit;
  }
  return { ...(await toView(actor, week, outcome.row)), cached: outcome.cached };

  function transact() {
    return db().transaction(async (tx) => {
    await advisoryLock(tx, `coach:${actor.id}:${week}`);

    const [existing] = await tx.select().from(coachSummary).where(ownedBy(coachSummary, actor, eq(coachSummary.isoWeek, week)));

    if (existing && existing.inputHash === inputHash) {
      log.info("coach.cached", { task: "weekly-coach", mode: existing.mode, habits: input.habits.length });
      return { row: existing, cached: true };
    }

    // Replacing a real summary is a refresh; replacing the fixed "no check-ins" message is not.
    const prev = existing && existing.mode !== "skipped" ? existing : undefined;
    const empty = !hasActivity(input);
    if (!empty && prev && prev.regenerations >= COACH_MAX_REFRESHES) {
      flags.limit = new CoachLimitError(REFRESH_CAP_MESSAGE, "refresh_cap");
      return { row: existing, cached: true };
    }

    if (!empty) {
      try {
        await consumeRate(tx, actor.id, "coach", COACH_CALLS_PER_HOUR, HOURLY_CAP_MESSAGE);
      } catch (err) {
        if (err instanceof TooManyRequestsError) {
          flags.limit = new CoachLimitError(HOURLY_CAP_MESSAGE, "hourly");
          return { row: existing, cached: true };
        }
        throw err;
      }
      if (!(await reserveDaily(tx, "coach", e.COACH_DAILY_CAP))) {
        // The rate row above is rolled back with this transaction: nothing was spent.
        throw new CoachLimitError(DAILY_CAP_MESSAGE, "daily_cap");
      }
    }

    let result;
    try {
      result = await composeCoach(input);
    } catch (err) {
      // An outage still counts as an attempt (the charge commits); nothing is stored.
      if (err instanceof AiError && err.kind !== "input_rejected") {
        flags.providerError = err;
        log.warn("coach.provider_failed", { task: "weekly-coach", kind: err.kind, habits: input.habits.length });
        return { row: existing, cached: true };
      }
      throw err;
    }

    const regenerations = prev && !empty ? prev.regenerations + 1 : (existing?.regenerations ?? 0);
    const values = {
      data: result.data,
      stats: storedStats(input),
      mode: result.mode,
      inputHash,
      regenerations,
    };
    const [row] = await tx
      .insert(coachSummary)
      .values({ userId: actor.id, isoWeek: week, ...values })
      .onConflictDoUpdate({
        target: [coachSummary.userId, coachSummary.isoWeek],
        set: { ...values, generatedAt: sql`now()` },
      })
      .returning();
    log.info("coach.generate", {
      task: "weekly-coach",
      mode: result.mode,
      habits: input.habits.length,
      called: result.called,
      latencyMs: result.latencyMs,
      guardrails: result.codes,
      valuesDropped: result.valuesDropped,
      regenerations,
    });
    return { row, cached: false };
    });
  }
}
