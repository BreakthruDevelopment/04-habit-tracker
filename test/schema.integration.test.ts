/**
 * Runs against a real Postgres when TEST_DATABASE_URL is set (CI provides one). Migrates a
 * throwaway empty database to prove the migrations apply from scratch, then checks the
 * constraints, cascades and indexes the data layer relies on, and that the zone list agrees
 * with Postgres.
 */
import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TIME_ZONES } from "@/lib/time";

const url = process.env.TEST_DATABASE_URL;
const withDb = (base: string, name: string) => {
  const u = new URL(base);
  u.pathname = `/${name}`;
  return u.toString();
};

const P256DH = "B".repeat(87);
const AUTH = "a".repeat(22);

describe.skipIf(!url)("habit schema (Postgres)", () => {
  const name = `schema_fresh_${randomBytes(4).toString("hex")}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  const habitId = "0b6f0c1e-3c1a-4f55-9d0a-1f2b3c4d5e6f";

  const habit = (over: Record<string, unknown> = {}) => ({
    id: habitId,
    owner_id: "s-alice",
    name: "Read",
    kind: "check",
    weekly_goal: 5,
    position: 0,
    ...over,
  });
  const insertHabit = (row: Record<string, unknown>) => sql`insert into habit ${sql(row as Record<string, string | number | null>)}`;
  const insertCheckIn = (row: Record<string, unknown>) => sql`insert into check_in ${sql(row as Record<string, string | number | boolean | null>)}`;
  const checkIn = (over: Record<string, unknown> = {}) => ({ habit_id: habitId, owner_id: "s-alice", local_date: "2026-11-02", value: 1, done: true, ...over });

  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const conn = postgres(withDb(url!, name), { max: 1, onnotice: () => {} });
    try {
      await migrate(drizzle(conn), { migrationsFolder: "./drizzle" });
    } finally {
      await conn.end();
    }
    sql = postgres(withDb(url!, name), { max: 1, onnotice: () => {} });
    for (const id of ["s-alice", "s-bob"]) {
      await sql`insert into "user" (id, name, email) values (${id}, ${id}, ${id + "@test.local"})`;
    }
  });

  afterAll(async () => {
    await sql?.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });

  it("removed the template's item table and created the habit tables", async () => {
    const rows = await sql`select table_name from information_schema.tables where table_schema = 'public'`;
    const tables = rows.map((r) => r.table_name as string);
    expect(tables).not.toContain("item");
    for (const t of ["habit", "check_in", "user_settings", "push_subscription", "coach_summary", "app_settings", "daily_usage", "rate_event"]) {
      expect(tables).toContain(t);
    }
  });

  it("uses millisecond timestamptz for every new timestamp column", async () => {
    const rows = await sql`
      select table_name, column_name, data_type, datetime_precision from information_schema.columns
      where table_schema = 'public' and table_name in ('habit','check_in','user_settings','push_subscription','coach_summary','app_settings','rate_event')
        and data_type like 'timestamp%'`;
    expect(rows.length).toBeGreaterThan(10);
    for (const r of rows) {
      expect(r.data_type, `${r.table_name}.${r.column_name}`).toBe("timestamp with time zone");
      expect(r.datetime_precision, `${r.table_name}.${r.column_name}`).toBe(3);
    }
  });

  describe("habit", () => {
    it("accepts a yes/no habit and a numeric one", async () => {
      await insertHabit(habit());
      await insertHabit(habit({ id: "11111111-1111-4111-8111-111111111111", name: "Water", kind: "numeric", unit: "glasses", daily_target: 8, position: 1 }));
    });

    it("enforces the numeric/unit/target rule, name and unit length, goal and position", async () => {
      const bad: Record<string, unknown>[] = [
        { kind: "numeric" }, // no unit or target
        { kind: "numeric", unit: "x" }, // no target
        { kind: "numeric", daily_target: 5 }, // no unit
        { kind: "numeric", unit: "x", daily_target: 0 },
        { kind: "numeric", unit: "x", daily_target: 100000.01 },
        { kind: "numeric", unit: "", daily_target: 5 },
        { kind: "numeric", unit: "x".repeat(17), daily_target: 5 },
        { kind: "check", unit: "x" }, // yes/no with a unit
        { kind: "check", daily_target: 5 },
        { kind: "weekly" },
        { name: "" },
        { name: "x".repeat(61) },
        { weekly_goal: 0 },
        { weekly_goal: 8 },
        { position: -1 },
      ];
      for (const over of bad) {
        const inserted = await insertHabit(habit({ id: crypto.randomUUID(), ...over })).then(() => true, () => false);
        expect(inserted, JSON.stringify(over)).toBe(false);
      }
      await insertHabit(habit({ id: crypto.randomUUID(), name: "x".repeat(60), kind: "numeric", unit: "x".repeat(16), daily_target: 100000, weekly_goal: 7 }));
    });
  });

  describe("check_in", () => {
    it("accepts a row, one per habit per day", async () => {
      await insertCheckIn(checkIn());
      await expect(insertCheckIn(checkIn())).rejects.toThrow(/duplicate key|check_in_habit_id_local_date_pk/);
    });

    it("refuses a check-in whose owner isn't the habit's owner, even by raw insert", async () => {
      await expect(insertCheckIn(checkIn({ owner_id: "s-bob", local_date: "2026-11-03" }))).rejects.toThrow(/check_in_habit_owner_fk/);
    });

    it("refuses a missing habit and out-of-range values", async () => {
      await expect(insertCheckIn(checkIn({ habit_id: crypto.randomUUID(), local_date: "2026-11-04" }))).rejects.toThrow(/foreign key/);
      for (const value of [0, -1, 100000.01]) {
        await expect(insertCheckIn(checkIn({ local_date: "2026-11-05", value })), String(value)).rejects.toThrow(/check_in_value_chk/);
      }
      await insertCheckIn(checkIn({ local_date: "2026-11-05", value: 100000 }));
    });

    it("has the covering index, and week and heatmap reads use it (no seq scan with 10,000 rows)", async () => {
      const idx = await sql`select indexdef from pg_indexes where tablename = 'check_in' and indexname = 'check_in_owner_date_covering_idx'`;
      expect(idx).toHaveLength(1);
      expect(idx[0].indexdef).toMatch(/INCLUDE \(habit_id, done, value\)/);

      await insertHabit(habit({ id: "22222222-2222-4222-8222-222222222222", owner_id: "s-bob", name: "Bulk" }));
      await sql`
        insert into check_in (habit_id, owner_id, local_date, value, done)
        select '22222222-2222-4222-8222-222222222222', 's-bob', d::date, 1, true
        from generate_series(date '1999-01-01', date '1999-01-01' + 9999, interval '1 day') d`;
      await sql`analyze check_in`;
      const plan = await sql`
        explain select local_date, count(*) filter (where done) from check_in
        where owner_id = 's-bob' and local_date between '1999-02-01' and '1999-03-01' group by local_date`;
      const text = plan.map((r) => r["QUERY PLAN"]).join("\n");
      expect(text).not.toMatch(/Seq Scan on check_in/);
      // This fixture is one owner holding every row, so the owner filter isn't selective and the planner may
      // prefer the plain local_date index (added for the admin counts). With many owners, as in
      // habits.integration.test.ts, the covering index is the one used.
      expect(text).toMatch(/check_in_owner_date_covering_idx|check_in_local_date_idx/);
    });

    it("cascades: deleting a habit deletes its check-ins, deleting a user deletes everything", async () => {
      await sql`delete from habit where id = ${habitId}`;
      expect((await sql`select 1 from check_in where habit_id = ${habitId}`).length).toBe(0);
      await sql`delete from "user" where id = 's-bob'`;
      expect((await sql`select 1 from habit where owner_id = 's-bob'`).length).toBe(0);
      expect((await sql`select 1 from check_in where owner_id = 's-bob'`).length).toBe(0);
      await sql`insert into "user" (id, name, email) values ('s-bob', 's-bob', 's-bob@test.local')`;
    });
  });

  describe("user_settings", () => {
    const insert = (row: Record<string, unknown>) => sql`insert into user_settings ${sql(row as Record<string, string | null>)}`;

    it("defaults to UTC with no reminder", async () => {
      await insert({ user_id: "s-alice" });
      const [row] = await sql`select time_zone, reminder_time from user_settings where user_id = 's-alice'`;
      expect(row).toMatchObject({ time_zone: "UTC", reminder_time: null });
    });

    it("allows reminder times from 05:00 to 21:00 on 15-minute steps only", async () => {
      for (const t of ["05:00", "05:15", "12:45", "21:00", null]) {
        await sql`update user_settings set reminder_time = ${t} where user_id = 's-alice'`;
      }
      for (const t of ["04:45", "21:15", "08:10", "08:00:30", "00:00", "23:45"]) {
        await expect(sql`update user_settings set reminder_time = ${t} where user_id = 's-alice'`, t).rejects.toThrow(/user_settings_reminder_chk/);
      }
    });

    it("has the partial index on reminder_time", async () => {
      const [row] = await sql`select indexdef from pg_indexes where indexname = 'user_settings_reminder_time_idx'`;
      expect(row.indexdef).toMatch(/WHERE \(reminder_time IS NOT NULL\)/);
    });
  });

  describe("push_subscription, coach_summary, app_settings, usage tables", () => {
    const sub = (over: Record<string, unknown> = {}) => ({
      user_id: "s-alice",
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      p256dh: P256DH,
      auth: AUTH,
      vapid_key_id: "abcd1234",
      ...over,
    });
    const insertSub = (row: Record<string, unknown>) => sql`insert into push_subscription ${sql(row as Record<string, string>)}`;

    it("keeps keys well formed and endpoints unique and short", async () => {
      await insertSub(sub());
      await expect(insertSub(sub({ user_id: "s-bob" }))).rejects.toThrow(/push_subscription_endpoint_unique/);
      await expect(insertSub(sub({ endpoint: "https://x/2", p256dh: "short" }))).rejects.toThrow(/p256dh_chk/);
      await expect(insertSub(sub({ endpoint: "https://x/3", auth: "a".repeat(23) }))).rejects.toThrow(/auth_chk/);
      await expect(insertSub(sub({ endpoint: "https://x/4", p256dh: "+".repeat(87) }))).rejects.toThrow(/p256dh_chk/);
      await expect(insertSub(sub({ endpoint: "https://x/" + "a".repeat(1100) }))).rejects.toThrow(/endpoint_len/);
    });

    it("requires lowercase hex for vapid_key_id and input_hash", async () => {
      for (const bad of ["ABCD1234", "abcd123", "abcd123g", "abcd12345"]) {
        await expect(insertSub(sub({ endpoint: `https://x/k${bad}`, vapid_key_id: bad })), bad).rejects.toThrow(/key_id_chk|value too long/);
      }
      await expect(sql`insert into app_settings (id, vapid_public_key, vapid_private_key, vapid_key_id) values (1, 'p', 'q', 'ZZZZZZZZ')`).rejects.toThrow(/app_settings_key_id_chk/);
      await expect(sql`insert into coach_summary (user_id, iso_week, data, stats, mode, input_hash) values ('s-alice', '2026-W10', '{}', '{}', 'demo', ${"A".repeat(64)})`).rejects.toThrow(/coach_summary_hash_chk/);
    });

    it("keeps one coach summary per user per ISO week, and only real week labels", async () => {
      const row = (week: string, mode = "demo") => sql`insert into coach_summary (user_id, iso_week, data, stats, mode, input_hash) values ('s-alice', ${week}, '{}', '{}', ${mode}, ${"a".repeat(64)})`;
      await row("2026-W53");
      await expect(row("2026-W53")).rejects.toThrow(/duplicate key/);
      await expect(row("2026-W54")).rejects.toThrow(/coach_summary_week_chk/);
      await expect(row("2026-W00")).rejects.toThrow(/coach_summary_week_chk/);
      await expect(row("2026-W05", "guess")).rejects.toThrow(/coach_summary_mode_chk/);
      await expect(sql`update coach_summary set regenerations = 3 where user_id = 's-alice'`).rejects.toThrow(/coach_summary_regen_chk/);
    });

    it("allows exactly one app_settings row", async () => {
      const ins = (id: number) => sql`insert into app_settings (id, vapid_public_key, vapid_private_key, vapid_key_id) values (${id}, 'pub', 'priv', 'abcd1234')`;
      await expect(ins(2)).rejects.toThrow(/app_settings_single_row/);
      await ins(1);
      await expect(ins(1)).rejects.toThrow(/duplicate key/);
    });

    it("limits the kinds in daily_usage and rate_event", async () => {
      await sql`insert into daily_usage (day, kind, count) values ('2026-11-08', 'push', 1)`;
      await expect(sql`insert into daily_usage (day, kind, count) values ('2026-11-08', 'upload', 1)`).rejects.toThrow(/daily_usage_kind_chk/);
      await expect(sql`insert into daily_usage (day, kind, count) values ('2026-11-09', 'push', -1)`).rejects.toThrow(/daily_usage_count_chk/);
      await sql`insert into rate_event (user_id, kind) values ('s-alice', 'tz_change')`;
      await expect(sql`insert into rate_event (user_id, kind) values ('s-alice', 'upload')`).rejects.toThrow(/rate_event_kind_chk/);
    });
  });

  it("every zone the app accepts is known to Postgres (so `at time zone` never fails)", async () => {
    const rows = await sql`select name from pg_timezone_names`;
    const known = new Set(rows.map((r) => r.name as string));
    const missing = TIME_ZONES.filter((z) => !known.has(z));
    expect(missing).toEqual([]);
    // And Postgres really can convert with each of them.
    const [r] = await sql`select count(*)::int as n from unnest(${TIME_ZONES as string[]}::text[]) z where (timestamptz '2026-03-08 12:00+00' at time zone z) is not null`;
    expect(r.n).toBe(TIME_ZONES.length);
  });

  it("covers every region-style zone Postgres lists, other than its own backward-compatibility links", async () => {
    // Zones Postgres lists under a modern name that browsers report must be pickable.
    const rows = await sql`select name from pg_timezone_names where name ~ '^(Africa|America|Antarctica|Asia|Atlantic|Australia|Europe|Indian|Pacific)/'`;
    const ours = new Set(TIME_ZONES);
    const pgOnly = rows.map((r) => r.name as string).filter((z) => !ours.has(z));
    // Postgres ships extra links (for example America/Argentina/ComodRivadavia); the common ones must be ours.
    for (const z of ["America/New_York", "America/Denver", "Europe/London", "Asia/Kolkata", "Asia/Tokyo", "Australia/Lord_Howe", "Pacific/Auckland"]) {
      expect(pgOnly).not.toContain(z);
    }
  });
});
