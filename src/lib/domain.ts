/** Constants shared by the schema, the data layer and (later) the UI. No imports, so the schema can use it. */

export const HABIT_KINDS = ["check", "numeric"] as const;
export type HabitKind = (typeof HABIT_KINDS)[number];

export const HABIT_NAME_MAX = 60;
export const HABIT_UNIT_MAX = 16;
/** A daily target or a check-in value must be above 0 and at most this. */
export const MAX_VALUE = 100_000;
export const MAX_ACTIVE_HABITS = 20;
export const MAX_TOTAL_HABITS = 50;
/** Check-ins may be written for today and this many days back. */
export const BACKFILL_DAYS = 7;

export const COACH_MODES = ["live", "demo", "skipped", "fallback"] as const;
export const DAILY_USAGE_KINDS = ["push", "coach", "demo_load"] as const;
export const RATE_KINDS = ["checkin", "habit_write", "subscribe", "test_push", "coach", "tz_change", "demo_load"] as const;

/** Reminder times are 05:00 to 21:00 in 15-minute steps. */
export const REMINDER_MIN_MINUTES = 5 * 60;
export const REMINDER_MAX_MINUTES = 21 * 60;
export const REMINDER_STEP_MINUTES = 15;

/** Zone changes allowed per rolling 24 hours. */
export const TZ_CHANGES_PER_DAY = 3;
export const DAY_SECONDS = 24 * 60 * 60;

export const MAX_PUSH_DEVICES = 5;

/** App-wide demo workspace loads allowed per UTC day. */
export const DEMO_LOADS_PER_DAY = 5;

/** Check-in writes (set or clear) allowed per user per rolling hour. */
export const CHECKINS_PER_HOUR = 200;
/** Habit writes (create, edit, archive, delete, reorder) allowed per user per rolling hour. */
export const HABIT_WRITES_PER_HOUR = 120;
/** Streaks and the heatmap look back this far. */
export const STREAK_LOOKBACK_DAYS = 400;
/** `GET /api/progress/week` accepts the current week and this many weeks before it, minus one (52 weeks in all). */
export const PROGRESS_WEEKS = 52;
export const HEATMAP_DAYS = 30;
export const HEATMAP_MAX_DAYS = 90;

/** Web push: per-user limits and what counts as a dead subscription. */
export const SUBSCRIBES_PER_HOUR = 20;
export const TEST_PUSHES_PER_HOUR = 3;
export const PUSH_MAX_FAILURES = 10;
export const PUSH_STALE_DAYS = 60;
/** Reminders go out from the chosen time until this long after it (never past local midnight). */
export const REMINDER_WINDOW_HOURS = 3;
/** A user isn't reminded again within this many hours, even if their local date repeats (zone change). */
export const REMINDER_MIN_GAP_HOURS = 12;
export const REMINDER_MAX_USERS_PER_RUN = 500;
export const PUSH_SEND_CONCURRENCY = 10;
export const PUSH_TIMEOUT_MS = 10_000;
export const PUSH_TTL_SECONDS = 4 * 60 * 60;

// Weekly coach
/** `generate()` calls per user per hour (every attempt counts, cached answers don't). */
export const COACH_CALLS_PER_HOUR = 6;
/** Regenerations of one week's summary after the first. */
export const COACH_MAX_REFRESHES = 2;
/** Real model calls per user per week: the first summary and its refreshes. Skipped (empty) weeks don't count. */
export const COACH_MAX_CALLS = 1 + COACH_MAX_REFRESHES;
/** A generation claim older than this is stale and can be taken over (the provider timeout is 20 s). */
export const COACH_CLAIM_SECONDS = 45;
