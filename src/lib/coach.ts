import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { ZodError, z } from "zod";
import { configuredModel } from "@/lib/ai";
import { AiError } from "@/lib/ai/types";
import { type Actor, ForbiddenError, UnauthorizedError, assertCan } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { COACH_CALLS_PER_HOUR, COACH_CLAIM_SECONDS, COACH_MAX_CALLS, COACH_MAX_REFRESHES } from "@/lib/domain";
import { env } from "@/lib/env";
import { BadRequestError, ConflictError, HttpError, TooManyRequestsError } from "@/lib/errors";
import { log } from "@/lib/log";
import { skippedOutput } from "@/lib/coach-guardrails";
import { ownedBy } from "@/lib/owned";
import { streaks, weekSummary } from "@/lib/progress";
import { getLocalDay } from "@/lib/settings";
import { isoWeek, parseIsoWeek, weekIndex } from "@/lib/time";
import { advisoryLock, consumeRate, releaseDaily, releaseRate, reserveDaily } from "@/lib/usage";
import {
  type CoachMode,
  type CoachOutput,
  type StoredStats,
  buildCoachInput,
  coachInputHash,
  composeCoach,
  hasActivity,
  storedStats,
} from "@/lib/weekly-coach";

const { coachSummary, coachClaim, habit } = schema;

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

/** Refreshes left after `calls` stored model calls: 2 before the first, then 2, 1, 0. */
function refreshesLeft(calls: number): number {
  return Math.max(0, COACH_MAX_CALLS - Math.max(calls, 1));
}

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
    refreshesLeft: refreshesLeft(row.modelCalls),
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

export const CLAIM_MESSAGE = "This week's summary is being generated. Try again in a moment.";

/** Concurrent requests for the same user and week in this process share one run (the claim covers other processes). */
const inflight = new Map<string, Promise<CoachGenerateResult>>();

/**
 * Generate (or regenerate) the summary for this week or last week.
 *
 * 1. A short transaction, under an advisory lock on (user, week): the same input hash returns the stored row; a week
 *    with no check-ins stores the fixed fresh-start message (no call); otherwise the call cap (3 stored calls a
 *    week: the summary and two refreshes) is checked, a claim row is taken (409 if another request holds a fresh
 *    one), and one of the user's 6 calls an hour and one of the app's `COACH_DAILY_CAP` a day is spent.
 * 2. The model call, outside any transaction: no connection or row lock is held while the model thinks.
 * 3. A second short transaction deletes the claim by token and stores the answer, but only if the row is still as
 *    it was in step 1. A failed call (provider outage, or a live provider's failure answered from the demo fixture)
 *    deletes the claim and refunds both caps; nothing is stored and any existing summary stays.
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

type Plan = { kind: "done"; row: Row; cached: boolean } | { kind: "claimed"; token: string; before: Row | undefined };

async function runGenerate(actor: Actor, week: string, now: Date): Promise<CoachGenerateResult> {
  const e = env();
  // Everything read from the pool happens here, outside the transactions, which only hold a connection briefly.
  const summary = await weekSummary(actor, week, now);
  const input = buildCoachInput(summary, await streaks(actor, now));
  const model = configuredModel();
  const inputHash = coachInputHash(input, model);
  const empty = !hasActivity(input);
  const lockName = `coach:${actor.id}:${week}`;
  const selectRow = (tx: Pick<ReturnType<typeof db>, "select">) =>
    tx.select().from(coachSummary).where(ownedBy(coachSummary, actor, eq(coachSummary.isoWeek, week)));

  // Step 1.
  let plan: Plan;
  try {
    plan = await db().transaction(async (tx): Promise<Plan> => {
      await advisoryLock(tx, lockName);
      const [existing] = await selectRow(tx);
      if (existing && existing.inputHash === inputHash) {
        log.info("coach.cached", { task: "weekly-coach", mode: existing.mode, habits: input.habits.length });
        return { kind: "done", row: existing, cached: true };
      }

      if (empty) {
        // No model call: store the fixed message. Whatever the week had before stays counted in `model_calls`.
        const values = { data: skippedOutput(input), stats: storedStats(input), mode: "skipped" as const, inputHash };
        const [row] = await tx
          .insert(coachSummary)
          .values({ userId: actor.id, isoWeek: week, ...values })
          .onConflictDoUpdate({ target: [coachSummary.userId, coachSummary.isoWeek], set: { ...values, generatedAt: sql`now()` } })
          .returning();
        log.info("coach.generate", { task: "weekly-coach", mode: "skipped", habits: input.habits.length, called: false });
        return { kind: "done", row, cached: false };
      }

      // The cap holds whatever the existing row is, a skipped one included: unchecking everything and checking
      // back in must not buy a fresh call.
      if (existing && existing.modelCalls >= COACH_MAX_CALLS) throw new CoachLimitError(REFRESH_CAP_MESSAGE, "refresh_cap");

      const token = randomUUID();
      const claimed = await tx
        .insert(coachClaim)
        .values({ userId: actor.id, isoWeek: week, token })
        .onConflictDoUpdate({
          target: [coachClaim.userId, coachClaim.isoWeek],
          set: { token, claimedAt: sql`now()` },
          setWhere: sql`${coachClaim.claimedAt} < now() - make_interval(secs => ${COACH_CLAIM_SECONDS})`,
        })
        .returning({ token: coachClaim.token });
      if (claimed.length === 0) throw new ConflictError(CLAIM_MESSAGE);

      // A refusal throws, which rolls back the claim and the rate row with it.
      try {
        await consumeRate(tx, actor.id, "coach", COACH_CALLS_PER_HOUR, HOURLY_CAP_MESSAGE);
      } catch (err) {
        if (err instanceof TooManyRequestsError) throw new CoachLimitError(HOURLY_CAP_MESSAGE, "hourly");
        throw err;
      }
      if (!(await reserveDaily(tx, "coach", e.COACH_DAILY_CAP))) throw new CoachLimitError(DAILY_CAP_MESSAGE, "daily_cap");
      return { kind: "claimed", token, before: existing };
    });
  } catch (err) {
    // A cap thrown inside the transaction (it rolled back, so nothing was spent) still gets the cached summary attached.
    if (err instanceof CoachLimitError && !err.view) {
      const [row] = await selectRow(db());
      err.view = await toView(actor, week, row);
    }
    throw err;
  }
  if (plan.kind === "done") return { ...(await toView(actor, week, plan.row)), cached: plan.cached };

  // Step 2: no transaction, no connection held.
  const { token, before } = plan;
  let result;
  try {
    result = await composeCoach(input);
    if (result.called && result.mode === "demo" && model !== "demo") {
      // A live provider failed and `generate()` answered from the demo fixture. That is not this week's summary.
      throw new AiError("The coach's model is unavailable right now. Try again in a moment.", "provider");
    }
  } catch (err) {
    log.warn("coach.call_failed", { task: "weekly-coach", kind: err instanceof AiError ? err.kind : "unexpected", habits: input.habits.length });
    await db().transaction(async (tx) => {
      await tx.delete(coachClaim).where(and(eq(coachClaim.userId, actor.id), eq(coachClaim.isoWeek, week), eq(coachClaim.token, token)));
      // A failed call spends nothing.
      await releaseRate(tx, actor.id, "coach");
      await releaseDaily(tx, "coach");
    });
    throw err;
  }

  // Step 3.
  const outcome = await db().transaction(async (tx): Promise<{ row: Row | undefined; stored: boolean }> => {
    await advisoryLock(tx, lockName);
    const mine = await tx
      .delete(coachClaim)
      .where(and(eq(coachClaim.userId, actor.id), eq(coachClaim.isoWeek, week), eq(coachClaim.token, token)))
      .returning({ token: coachClaim.token });
    const [current] = await selectRow(tx);
    // The claim was taken over (this call outlived it), or the row changed since step 1: the stored answer stands.
    const unchanged = current?.modelCalls === before?.modelCalls && current?.inputHash === before?.inputHash;
    if (mine.length === 0 || !unchanged) return { row: current, stored: false };

    const modelCalls = (before?.modelCalls ?? 0) + 1;
    const values = {
      data: result.data,
      stats: storedStats(input),
      mode: result.mode,
      inputHash,
      modelCalls,
      regenerations: Math.max(0, modelCalls - 1),
    };
    const [row] = await tx
      .insert(coachSummary)
      .values({ userId: actor.id, isoWeek: week, ...values })
      .onConflictDoUpdate({ target: [coachSummary.userId, coachSummary.isoWeek], set: { ...values, generatedAt: sql`now()` } })
      .returning();
    return { row, stored: true };
  });
  if (!outcome.row) throw new ConflictError(CLAIM_MESSAGE);
  log.info("coach.generate", {
    task: "weekly-coach",
    mode: result.mode,
    habits: input.habits.length,
    called: result.called,
    latencyMs: result.latencyMs,
    guardrails: result.codes,
    valuesDropped: result.valuesDropped,
    stored: outcome.stored,
    modelCalls: outcome.row.modelCalls,
  });
  return { ...(await toView(actor, week, outcome.row)), cached: !outcome.stored };
}
