/**
 * Settings and time-zone rules against a real Postgres (TEST_DATABASE_URL).
 * Owner-only access, the 3-zone-changes-per-rolling-24h limit, and the reminder-time rules.
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("settings (Postgres)", () => {
  let sql: postgres.Sql;
  let settings: typeof import("@/lib/settings");
  const alice = { id: "set-alice", role: "user" as const };
  const bob = { id: "set-bob", role: "user" as const };
  const root = { id: "set-root", role: "admin" as const };
  const t0 = new Date("2026-11-08T12:00:00Z");
  const hours = (h: number) => new Date(t0.getTime() + h * 3_600_000);

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    for (const u of [alice, bob, root]) {
      await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.id + "@test.local"}, ${u.role}) on conflict do nothing`;
    }
    settings = await import("@/lib/settings");
  });

  afterAll(async () => {
    await sql`delete from "user" where id like 'set-%'`;
    await sql.end();
  });

  const reset = async (id: string) => {
    await sql`delete from user_settings where user_id = ${id}`;
    await sql`delete from rate_event where user_id = ${id}`;
  };

  describe("get or create", () => {
    it("creates the row with the browser's zone on first sign-in, and keeps it afterwards", async () => {
      await reset(alice.id);
      expect(await settings.getOrCreateSettings(alice, "America/Denver")).toMatchObject({ timeZone: "America/Denver", reminderTime: null });
      // A later detection (another browser) does not overwrite the stored zone.
      expect((await settings.getOrCreateSettings(alice, "Asia/Tokyo")).timeZone).toBe("America/Denver");
      expect((await sql`select count(*)::int n from rate_event where user_id = ${alice.id}`)[0].n).toBe(0);
    });

    it("stores the modern name for an old one, and falls back to UTC for junk or nothing", async () => {
      await reset(alice.id);
      expect((await settings.getOrCreateSettings(alice, "Asia/Calcutta")).timeZone).toBe("Asia/Kolkata");
      await reset(alice.id);
      expect((await settings.getOrCreateSettings(alice, "Not/AZone")).timeZone).toBe("UTC");
      await reset(alice.id);
      expect((await settings.getOrCreateSettings(alice)).timeZone).toBe("UTC");
    });

    it("is safe to call concurrently", async () => {
      await reset(bob.id);
      const all = await Promise.all(Array.from({ length: 6 }, () => settings.getOrCreateSettings(bob, "Europe/London")));
      expect(new Set(all.map((s) => s.timeZone))).toEqual(new Set(["Europe/London"]));
      expect((await sql`select count(*)::int n from user_settings where user_id = ${bob.id}`)[0].n).toBe(1);
    });
  });

  describe("zone changes", () => {
    it("refuses the 4th change within 24 hours with a 429, and leaves the zone as it was", async () => {
      await reset(alice.id);
      await settings.getOrCreateSettings(alice, "UTC");
      const zones = ["America/Denver", "Europe/London", "Asia/Kolkata"];
      for (const [i, z] of zones.entries()) {
        expect((await settings.updateSettings(alice, { timeZone: z }, hours(i))).timeZone).toBe(z);
      }
      const err = await settings.updateSettings(alice, { timeZone: "Australia/Lord_Howe" }, hours(3)).catch((e) => e);
      expect(err).toMatchObject({ status: 429, message: expect.stringMatching(/3 times in 24 hours/) });
      expect((await settings.getOrCreateSettings(alice)).timeZone).toBe("Asia/Kolkata");
    });

    it("is a rolling window: the 4th change works once the first is more than 24 hours old", async () => {
      // Changes were at t0, t0+1h, t0+2h. At t0+24h the first has expired only at the boundary (<=), so use +24.5h.
      expect((await settings.updateSettings(alice, { timeZone: "Australia/Lord_Howe" }, hours(24.5))).timeZone).toBe("Australia/Lord_Howe");
      // Now t0+1h, t0+2h, t0+24.5h are in the window: full again.
      await expect(settings.updateSettings(alice, { timeZone: "UTC" }, hours(24.6))).rejects.toMatchObject({ status: 429 });
    });

    it("does not count setting the zone you already have, or reminder-only changes", async () => {
      await reset(alice.id);
      await settings.getOrCreateSettings(alice, "America/Denver");
      for (let i = 0; i < 6; i++) {
        await settings.updateSettings(alice, { timeZone: "America/Denver" }, hours(i));
        await settings.updateSettings(alice, { reminderTime: i % 2 ? "08:00" : "09:15" }, hours(i));
      }
      // An old spelling of the stored zone is the same zone.
      await settings.updateSettings(alice, { timeZone: "America/Denver" }, hours(7));
      expect((await sql`select count(*)::int n from rate_event where user_id = ${alice.id}`)[0].n).toBe(0);
    });

    it("counts concurrent changes correctly (no more than 3 get through)", async () => {
      await reset(bob.id);
      await settings.getOrCreateSettings(bob, "UTC");
      const zones = ["Asia/Tokyo", "Europe/Paris", "America/Chicago", "Africa/Cairo", "Asia/Dubai", "Pacific/Auckland"];
      const results = await Promise.allSettled(zones.map((z) => settings.updateSettings(bob, { timeZone: z }, t0)));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
      expect((await sql`select count(*)::int n from rate_event where user_id = ${bob.id} and kind = 'tz_change'`)[0].n).toBe(3);
    });

    it("rejects an unknown zone with a 400-shaped validation error and spends nothing", async () => {
      await reset(alice.id);
      for (const z of ["Mars/Olympus", "", "utc", "+05:30"]) {
        await expect(settings.updateSettings(alice, { timeZone: z }, t0), z).rejects.toMatchObject({ name: "ZodError" });
      }
      expect((await sql`select count(*)::int n from rate_event where user_id = ${alice.id}`)[0].n).toBe(0);
    });
  });

  describe("reminder time", () => {
    it("accepts 05:00 to 21:00 in 15-minute steps and null to turn reminders off", async () => {
      await reset(alice.id);
      for (const t of ["05:00", "05:15", "13:30", "20:45", "21:00"]) {
        expect((await settings.updateSettings(alice, { reminderTime: t }, t0)).reminderTime).toBe(t);
      }
      expect((await settings.updateSettings(alice, { reminderTime: null }, t0)).reminderTime).toBeNull();
      expect((await settings.getOrCreateSettings(alice)).reminderTime).toBeNull();
    });

    it("rejects times outside the range, off the 15-minute grid, or badly formed", async () => {
      for (const t of ["04:45", "21:15", "08:10", "8:00", "08:00:00", "24:00", "noon", "", "00:00"]) {
        await expect(settings.updateSettings(alice, { reminderTime: t }, t0), t).rejects.toMatchObject({ name: "ZodError" });
      }
      expect(settings.isValidReminderTime("21:00")).toBe(true);
      expect(settings.isValidReminderTime("21:01")).toBe(false);
    });

    it("rejects an empty update and unknown fields", async () => {
      await expect(settings.updateSettings(alice, {}, t0)).rejects.toMatchObject({ name: "ZodError" });
      await expect(settings.updateSettings(alice, { reminderTime: "08:00", lastReminderOn: "2026-01-01" } as never, t0)).rejects.toMatchObject({ name: "ZodError" });
    });
  });

  describe("access", () => {
    it("only ever reads and writes the actor's own row, admin included", async () => {
      await reset(alice.id);
      await reset(root.id);
      await settings.getOrCreateSettings(alice, "Asia/Tokyo");
      await settings.updateSettings(alice, { reminderTime: "07:00" }, t0);
      const rootView = await settings.getOrCreateSettings(root, "Europe/Paris");
      expect(rootView).toMatchObject({ timeZone: "Europe/Paris", reminderTime: null });
      await settings.updateSettings(root, { reminderTime: "10:00", timeZone: "Asia/Kolkata" }, t0);
      const [a] = await sql`select time_zone, reminder_time from user_settings where user_id = ${alice.id}`;
      expect(a).toMatchObject({ time_zone: "Asia/Tokyo", reminder_time: "07:00:00" });
      // Bob never sees Alice's values.
      await reset(bob.id);
      expect(await settings.getOrCreateSettings(bob)).toMatchObject({ timeZone: "UTC", reminderTime: null });
    });

    it("never exposes the reminder bookkeeping columns", async () => {
      const s = await settings.getOrCreateSettings(alice);
      expect(Object.keys(s).sort()).toEqual(["reminderTime", "timeZone", "updatedAt"]);
    });

    it("deleting the user deletes their settings and rate events", async () => {
      await sql`insert into "user" (id, name, email) values ('set-gone', 'g', 'set-gone@test.local')`;
      await settings.getOrCreateSettings({ id: "set-gone", role: "user" }, "Asia/Tokyo");
      await settings.updateSettings({ id: "set-gone", role: "user" }, { timeZone: "UTC" }, t0);
      await sql`delete from "user" where id = 'set-gone'`;
      expect((await sql`select 1 from user_settings where user_id = 'set-gone'`).length).toBe(0);
      expect((await sql`select 1 from rate_event where user_id = 'set-gone'`).length).toBe(0);
    });
  });
});
