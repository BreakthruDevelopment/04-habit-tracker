import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import {
  COACH_MODES,
  DAILY_USAGE_KINDS,
  HABIT_KINDS,
  HABIT_NAME_MAX,
  HABIT_UNIT_MAX,
  MAX_VALUE,
  RATE_KINDS,
} from "@/lib/domain";

/** SQL list literal for a CHECK constraint, built from a trusted constant array. */
const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));
/** Conflict tokens and ordering need milliseconds: timestamptz(3) matches what JS Dates carry. */
const ts = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });

// ---------------------------------------------------------------------------
// Auth tables (shape required by Better Auth with the admin plugin).
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  role: text("role").notNull().default("user"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Habit tracker. Every row carries owner_id (or user_id); queries filter on it
// (see src/lib/owned.ts). Admin reads counts only, never these rows.
// ---------------------------------------------------------------------------

export const habit = pgTable(
  "habit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind", { enum: HABIT_KINDS }).notNull().default("check"),
    unit: text("unit"),
    dailyTarget: numeric("daily_target", { precision: 10, scale: 2 }),
    weeklyGoal: smallint("weekly_goal").notNull().default(7),
    position: smallint("position").notNull().default(0),
    archivedAt: ts("archived_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // The target of the composite foreign key from check_in.
    unique("habit_id_owner_uq").on(t.id, t.ownerId),
    index("habit_owner_archived_position_idx").on(t.ownerId, t.archivedAt, t.position),
    check("habit_name_len", sql`char_length(${t.name}) between 1 and ${sql.raw(String(HABIT_NAME_MAX))}`),
    check("habit_kind_chk", sql`${t.kind} in (${list(HABIT_KINDS)})`),
    // A numeric habit has a unit and a target in range; a yes/no habit has neither. (Spell out `is not null`: a
    // CHECK passes on NULL, so `target > 0` alone would let a missing target through.)
    check(
      "habit_numeric_chk",
      sql`(${t.kind} = 'numeric' and ${t.unit} is not null and char_length(${t.unit}) between 1 and ${sql.raw(String(HABIT_UNIT_MAX))} and ${t.dailyTarget} is not null and ${t.dailyTarget} > 0 and ${t.dailyTarget} <= ${sql.raw(String(MAX_VALUE))}) or (${t.kind} = 'check' and ${t.unit} is null and ${t.dailyTarget} is null)`,
    ),
    check("habit_weekly_goal_chk", sql`${t.weeklyGoal} between 1 and 7`),
    check("habit_position_chk", sql`${t.position} >= 0`),
  ],
);

/**
 * The time series: one row per habit per local day. The covering index
 * (owner_id, local_date) INCLUDE (habit_id, done, value) is added by a custom migration
 * (`checkin-covering-index`), because Drizzle can't express INCLUDE.
 */
export const checkIn = pgTable(
  "check_in",
  {
    habitId: uuid("habit_id").notNull(),
    localDate: date("local_date", { mode: "string" }).notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Yes/no habits always store 1 (enforced in the data layer, since a CHECK can't see the habit).
    value: numeric("value", { precision: 10, scale: 2 }).notNull().default("1"),
    // Fixed at write time, so changing a target later doesn't rewrite history.
    done: boolean("done").notNull().default(true),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.habitId, t.localDate] }),
    // A check-in can't belong to anyone but its habit's owner, even through a bug.
    foreignKey({ columns: [t.habitId, t.ownerId], foreignColumns: [habit.id, habit.ownerId], name: "check_in_habit_owner_fk" }).onDelete("cascade"),
    check("check_in_value_chk", sql`${t.value} > 0 and ${t.value} <= ${sql.raw(String(MAX_VALUE))}`),
  ],
);

export const userSettings = pgTable(
  "user_settings",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    timeZone: text("time_zone").notNull().default("UTC"),
    // null = no reminders.
    reminderTime: time("reminder_time"),
    lastReminderOn: date("last_reminder_on", { mode: "string" }),
    lastReminderAt: ts("last_reminder_at"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("user_settings_reminder_time_idx").on(t.reminderTime).where(sql`${t.reminderTime} is not null`),
    check("user_settings_tz_len", sql`char_length(${t.timeZone}) between 1 and 64`),
    check(
      "user_settings_reminder_chk",
      sql`${t.reminderTime} is null or (${t.reminderTime} between time '05:00' and time '21:00' and extract(minute from ${t.reminderTime})::int % 15 = 0 and extract(second from ${t.reminderTime}) = 0)`,
    ),
  ],
);

export const pushSubscription = pgTable(
  "push_subscription",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    // base64url without padding: a 65-byte P-256 point is 87 characters, the 16-byte auth secret 22.
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    deviceLabel: text("device_label").notNull().default("Browser"),
    // Hash prefix of the VAPID public key, so rotating the keys can prune stale subscriptions.
    vapidKeyId: char("vapid_key_id", { length: 8 }).notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    lastSuccessAt: ts("last_success_at"),
    failureCount: integer("failure_count").notNull().default(0),
    lastStatus: integer("last_status"),
  },
  (t) => [
    index("push_subscription_user_idx").on(t.userId),
    check("push_subscription_endpoint_len", sql`char_length(${t.endpoint}) between 1 and 1024`),
    check("push_subscription_p256dh_chk", sql`${t.p256dh} ~ '^[A-Za-z0-9_-]{87}$'`),
    check("push_subscription_auth_chk", sql`${t.auth} ~ '^[A-Za-z0-9_-]{22}$'`),
    check("push_subscription_key_id_chk", sql`${t.vapidKeyId} ~ '^[0-9a-f]{8}$'`),
    check("push_subscription_label_len", sql`char_length(${t.deviceLabel}) between 1 and 60`),
    check("push_subscription_failures_chk", sql`${t.failureCount} >= 0`),
  ],
);

/** One cached weekly coach summary per user per ISO week (in the user's zone). */
export const coachSummary = pgTable(
  "coach_summary",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    isoWeek: char("iso_week", { length: 8 }).notNull(),
    data: jsonb("data").notNull(),
    // What the model was shown (no habit names).
    stats: jsonb("stats").notNull(),
    mode: text("mode", { enum: COACH_MODES }).notNull(),
    inputHash: char("input_hash", { length: 64 }).notNull(),
    regenerations: smallint("regenerations").notNull().default(0),
    generatedAt: ts("generated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.isoWeek] }),
    check("coach_summary_week_chk", sql`${t.isoWeek} ~ '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$'`),
    check("coach_summary_mode_chk", sql`${t.mode} in (${list(COACH_MODES)})`),
    check("coach_summary_hash_chk", sql`${t.inputHash} ~ '^[0-9a-f]{64}$'`),
    check("coach_summary_regen_chk", sql`${t.regenerations} between 0 and 2`),
  ],
);

/**
 * The single app-wide row holding the VAPID key pair, written only by getVapidKeys() under an
 * advisory lock. Read server-side only; no route returns the private key.
 */
export const appSettings = pgTable(
  "app_settings",
  {
    id: smallint("id").primaryKey().default(1),
    vapidPublicKey: text("vapid_public_key").notNull(),
    vapidPrivateKey: text("vapid_private_key").notNull(),
    vapidKeyId: char("vapid_key_id", { length: 8 }).notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    check("app_settings_single_row", sql`${t.id} = 1`),
    check("app_settings_key_id_chk", sql`${t.vapidKeyId} ~ '^[0-9a-f]{8}$'`),
  ],
);

/** App-wide daily counters (one row per UTC day and kind) for the free-tier caps. */
export const dailyUsage = pgTable(
  "daily_usage",
  {
    day: date("day", { mode: "string" }).notNull(),
    kind: text("kind", { enum: DAILY_USAGE_KINDS }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.kind] }),
    check("daily_usage_kind_chk", sql`${t.kind} in (${list(DAILY_USAGE_KINDS)})`),
    check("daily_usage_count_chk", sql`${t.count} >= 0`),
  ],
);

/** Per-user rate-limit ledger: one row per attempt, counted over a sliding window. */
export const rateEvent = pgTable(
  "rate_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: RATE_KINDS }).notNull(),
    at: ts("at").notNull().defaultNow(),
  },
  (t) => [
    index("rate_event_user_kind_at_idx").on(t.userId, t.kind, t.at),
    check("rate_event_kind_chk", sql`${t.kind} in (${list(RATE_KINDS)})`),
  ],
);

export type User = typeof user.$inferSelect;
export type Habit = typeof habit.$inferSelect;
export type CheckIn = typeof checkIn.$inferSelect;
export type UserSettings = typeof userSettings.$inferSelect;
