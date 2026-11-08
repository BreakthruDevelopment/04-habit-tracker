/**
 * Habits, check-ins, streaks, summaries and the API against a real Postgres (TEST_DATABASE_URL).
 * Routes are called as functions with the signed-in user mocked, so the real handlers, zod, ownership
 * filters and error mapping all run.
 */
import { sql as dsql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;

type U = { id: string; role: "user" | "admin"; name: string; email: string };
const state = vi.hoisted(() => ({ user: null as null | { id: string; role: "user" | "admin"; name: string; email: string } }));

vi.mock("@/lib/auth/session", async () => {
  const { ForbiddenError, UnauthorizedError } = await import("@/lib/auth/rbac");
  const requireUser = async () => {
    if (!state.user) throw new UnauthorizedError();
    return state.user;
  };
  return {
    requireUser,
    requireRole: async (role: string) => {
      const u = await requireUser();
      if (role === "admin" && u.role !== "admin") throw new ForbiddenError();
      return u;
    },
  };
});

const PASSWORD = "correct-horse-battery";
const ORIGIN = "http://localhost:3000";
const at = (iso: string) => new Date(iso);

describe.skipIf(!url)("habits (Postgres)", () => {
  let sql: postgres.Sql;
  let habits: typeof import("@/lib/habits");
  let checkins: typeof import("@/lib/checkins");
  let progress: typeof import("@/lib/progress");
  let settings: typeof import("@/lib/settings");
  let dbm: typeof import("@/lib/db");

  const mkUser = (id: string, role: "user" | "admin" = "user"): U => ({ id: `hb-${id}`, role, name: `Name ${id}`, email: `hb-${id}@test.local` });
  const ada = mkUser("ada");
  const ben = mkUser("ben");
  const root = mkUser("root", "admin");
  const all = [ada, ben, root];

  const habitIn = async (u: U, over: Record<string, unknown> = {}) =>
    habits.createHabit(u, { name: "Read", ...over });
  const setZone = async (u: U, tz: string) => {
    await sql`insert into user_settings (user_id, time_zone) values (${u.id}, ${tz}) on conflict (user_id) do update set time_zone = ${tz}`;
  };
  /** Raw done check-ins on the given dates (bypasses the 7-day window and the rate limit). */
  const seed = async (u: U, habitId: string, dates: string[], done = true) => {
    for (const d of dates) {
      await sql`insert into check_in (habit_id, owner_id, local_date, value, done) values (${habitId}, ${u.id}, ${d}, 1, ${done}) on conflict do nothing`;
    }
  };
  const asUser = (u: U | null) => void (state.user = u);
  const json = (method: string, body?: unknown) =>
    new Request("http://localhost:3000/x", {
      method,
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });

  async function reset() {
    await sql`delete from habit where owner_id like 'hb-%'`;
    await sql`delete from rate_event where user_id like 'hb-%'`;
    await sql`delete from user_settings where user_id like 'hb-%'`;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    for (const u of all) {
      await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.name}, ${u.email}, ${u.role}) on conflict do nothing`;
    }
    habits = await import("@/lib/habits");
    checkins = await import("@/lib/checkins");
    progress = await import("@/lib/progress");
    settings = await import("@/lib/settings");
    dbm = await import("@/lib/db");
  });

  afterAll(async () => {
    await sql`delete from "user" where id like 'hb-%' or email like 'hb-%@test.local'`;
    await sql.end();
  });

  afterEach(() => {
    vi.useRealTimers();
    asUser(null);
  });

  // -------------------------------------------------------------------------
  describe("ownership", () => {
    it("gives another user and admin a 404 on get, patch, delete, check-in and heatmap", async () => {
      await reset();
      const h = await habitIn(ada);
      const today = new Date().toISOString().slice(0, 10);
      const route = await import("@/app/api/habits/[id]/route");
      const ci = await import("@/app/api/habits/[id]/check-ins/[date]/route");
      const hm = await import("@/app/api/progress/heatmap/route");
      const prog = await import("@/app/api/habits/[id]/progress/route");

      for (const intruder of [ben, root]) {
        asUser(intruder);
        const c = ctx({ id: h.id });
        expect((await route.GET(json("GET"), c)).status).toBe(404);
        expect((await route.PATCH(json("PATCH", { updatedAt: h.updatedAt, name: "Mine now" }), c)).status).toBe(404);
        expect((await route.DELETE(json("DELETE"), c)).status).toBe(404);
        expect((await ci.PUT(json("PUT", {}), ctx({ id: h.id, date: today }))).status).toBe(404);
        expect((await ci.DELETE(json("DELETE"), ctx({ id: h.id, date: today }))).status).toBe(404);
        expect((await hm.GET(new Request(`http://localhost:3000/api/progress/heatmap?habitId=${h.id}`))).status).toBe(404);
        expect((await prog.GET(json("GET"), c)).status).toBe(404);
        // A stale token or bad date can't turn a 404 into a different answer.
        expect((await route.PATCH(json("PATCH", { updatedAt: "2001-01-01T00:00:00.000Z" }), c)).status).toBe(404);
        expect((await ci.PUT(json("PUT", {}), ctx({ id: h.id, date: "2001-01-01" }))).status).toBe(404);
        // Not in their list either.
        expect(await habits.listHabits(intruder)).toEqual([]);
      }
      expect((await sql`select name from habit where id = ${h.id}`)[0].name).toBe("Read");
      asUser(ada);
      expect((await route.GET(json("GET"), ctx({ id: h.id }))).status).toBe(200);
      expect((await route.GET(json("GET"), ctx({ id: "not-a-uuid" }))).status).toBe(404);
    });

    it("refuses signed-out callers, and cross-origin writes", async () => {
      const list = await import("@/app/api/habits/route");
      asUser(null);
      expect((await list.GET(json("GET"))).status).toBe(401);
      asUser(ada);
      const foreign = new Request("http://localhost:3000/x", {
        method: "POST",
        headers: { origin: "https://evil.example", "content-type": "application/json" },
        body: JSON.stringify({ name: "x" }),
      });
      expect((await list.POST(foreign)).status).toBe(403);
      const noOrigin = new Request("http://localhost:3000/x", { method: "POST", body: JSON.stringify({ name: "x" }) });
      expect((await list.POST(noOrigin)).status).toBe(403);
      const big = new Request("http://localhost:3000/x", { method: "POST", headers: { origin: ORIGIN }, body: JSON.stringify({ name: "x".repeat(20_000) }) });
      expect((await list.POST(big)).status).toBe(413);
    });

    it("fails a raw check-in whose owner doesn't match the habit's owner at the foreign key", async () => {
      await reset();
      const h = await habitIn(ada);
      await expect(
        sql`insert into check_in (habit_id, owner_id, local_date, value, done) values (${h.id}, ${ben.id}, '2026-11-02', 1, true)`,
      ).rejects.toMatchObject({ code: "23503", constraint_name: "check_in_habit_owner_fk" });
    });
  });

  // -------------------------------------------------------------------------
  describe("habits", () => {
    it("creates, lists in order, validates input and keeps the shape rules", async () => {
      await reset();
      const a = await habitIn(ada, { name: "  Read  ", weeklyGoal: 5 });
      const b = await habitIn(ada, { name: "Water", kind: "numeric", unit: "glasses", dailyTarget: "8" });
      expect(a).toMatchObject({ name: "Read", kind: "check", unit: null, dailyTarget: null, weeklyGoal: 5, position: 0 });
      expect(b).toMatchObject({ kind: "numeric", unit: "glasses", dailyTarget: "8", weeklyGoal: 7, position: 1 });
      expect((await habits.listHabits(ada)).map((h) => h.name)).toEqual(["Read", "Water"]);
      for (const bad of [
        { name: "" },
        { name: "x".repeat(61) },
        { name: "N", kind: "numeric" },
        { name: "N", kind: "numeric", unit: "g", dailyTarget: "0" },
        { name: "N", kind: "numeric", unit: "g", dailyTarget: "100001" },
        { name: "N", kind: "numeric", unit: "g", dailyTarget: "1.234" },
        { name: "C", unit: "g" },
        { name: "C", weeklyGoal: 8 },
        { name: "C", weeklyGoal: 0 },
        { name: "C", ownerId: ben.id },
      ]) {
        await expect(habits.createHabit(ada, bad)).rejects.toMatchObject({ name: expect.stringMatching(/ZodError|BadRequestError/) });
      }
    });

    it("answers a stale updatedAt with 409 and a fresh one with the update", async () => {
      await reset();
      const h = await habitIn(ada);
      const route = await import("@/app/api/habits/[id]/route");
      asUser(ada);
      const ok = await route.PATCH(json("PATCH", { updatedAt: h.updatedAt, name: "Read more" }), ctx({ id: h.id }));
      expect(ok.status).toBe(200);
      const { habit: updated } = (await ok.json()) as { habit: { updatedAt: string; name: string } };
      expect(updated.name).toBe("Read more");
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(h.updatedAt.getTime());
      // The old token is now stale.
      const stale = await route.PATCH(json("PATCH", { updatedAt: h.updatedAt, name: "Lost update" }), ctx({ id: h.id }));
      expect(stale.status).toBe(409);
      // The new token round-trips through JSON.
      expect((await route.PATCH(json("PATCH", { updatedAt: updated.updatedAt, weeklyGoal: 3 }), ctx({ id: h.id }))).status).toBe(200);
      expect((await habits.getHabit(ada, h.id)).name).toBe("Read more");
    });

    it("refuses a change of kind once there are check-ins, and archives, restores and reorders", async () => {
      await reset();
      const h = await habitIn(ada);
      const g = await habitIn(ada, { name: "Run" });
      await checkins.setCheckIn(ada, h.id, new Date().toISOString().slice(0, 10));
      const fresh = await habits.getHabit(ada, h.id);
      await expect(
        habits.updateHabit(ada, h.id, { updatedAt: fresh.updatedAt.toISOString(), kind: "numeric", unit: "pages", dailyTarget: "10" }),
      ).rejects.toMatchObject({ status: 409 });
      // Without check-ins the kind can change, and then the new kind's fields are required.
      await expect(habits.updateHabit(ada, g.id, { updatedAt: g.updatedAt.toISOString(), kind: "numeric" })).rejects.toMatchObject({ status: 400 });
      const changed = await habits.updateHabit(ada, g.id, { updatedAt: g.updatedAt.toISOString(), kind: "numeric", unit: "km", dailyTarget: "5" });
      expect(changed).toMatchObject({ kind: "numeric", unit: "km", dailyTarget: "5" });

      await habits.reorderHabits(ada, { ids: [g.id, h.id] });
      expect((await habits.listHabits(ada)).map((x) => x.id)).toEqual([g.id, h.id]);
      await expect(habits.reorderHabits(ada, { ids: [g.id] })).rejects.toMatchObject({ status: 400 });
      await expect(habits.reorderHabits(ada, { ids: [g.id, g.id] })).rejects.toMatchObject({ status: 400 });
      const theirs = await habitIn(ben);
      await expect(habits.reorderHabits(ada, { ids: [g.id, h.id, theirs.id] })).rejects.toMatchObject({ status: 400 });

      await habits.archiveHabit(ada, g.id);
      expect((await habits.listHabits(ada)).map((x) => x.id)).toEqual([h.id]);
      expect((await habits.listHabits(ada, { archived: true })).map((x) => x.id)).toEqual([g.id]);
      // Archived habits take no check-ins.
      await expect(checkins.setCheckIn(ada, g.id, new Date().toISOString().slice(0, 10), { value: "5" })).rejects.toMatchObject({ status: 409 });
      const back = await habits.archiveHabit(ada, g.id, false);
      expect(back.archivedAt).toBeNull();
      expect((await habits.listHabits(ada)).map((x) => x.id)).toEqual([h.id, g.id]);
    });

    it("deletes a habit with its check-ins", async () => {
      await reset();
      const h = await habitIn(ada);
      await checkins.setCheckIn(ada, h.id, new Date().toISOString().slice(0, 10));
      await habits.deleteHabit(ada, h.id);
      expect((await sql`select count(*)::int n from check_in where habit_id = ${h.id}`)[0].n).toBe(0);
      await expect(habits.deleteHabit(ada, h.id)).rejects.toMatchObject({ status: 404 });
    });

    it("refuses the 21st active habit (and restoring into a full list), and the 51st habit", async () => {
      await reset();
      for (let i = 0; i < 20; i++) await habitIn(ben, { name: `H${i}` });
      await expect(habitIn(ben, { name: "H20" })).rejects.toMatchObject({ status: 409 });
      const [first] = await habits.listHabits(ben);
      await habits.archiveHabit(ben, first.id);
      await habitIn(ben, { name: "replacement" });
      await expect(habits.archiveHabit(ben, first.id, false)).rejects.toMatchObject({ status: 409 });
      // 30 more archived habits reach the 50 total.
      for (let i = 0; i < 29; i++) {
        const h = await sql`insert into habit (owner_id, name, kind, weekly_goal, position, archived_at) values (${ben.id}, ${"old" + i}, 'check', 7, 0, now()) returning id`;
        expect(h).toHaveLength(1);
      }
      await expect(habits.archiveHabit(ben, (await habits.listHabits(ben))[0].id)).resolves.toBeDefined();
      await expect(habitIn(ben, { name: "one too many" })).rejects.toMatchObject({ status: 409 });
    });
  });

  // -------------------------------------------------------------------------
  describe("check-ins", () => {
    const now = at("2026-11-08T15:00:00Z"); // 08:00 in Denver, 15:00 UTC: both zones say 2026-11-08

    it("accepts today back to today - 7, and answers 400 for a future date and today - 8", async () => {
      await reset();
      await setZone(ada, "UTC");
      const h = await habitIn(ada);
      await expect(checkins.setCheckIn(ada, h.id, "2026-11-08", {}, now)).resolves.toMatchObject({ date: "2026-11-08", done: true, value: "1" });
      await expect(checkins.setCheckIn(ada, h.id, "2026-11-01", {}, now)).resolves.toMatchObject({ date: "2026-11-01" });
      await expect(checkins.setCheckIn(ada, h.id, "2026-11-09", {}, now)).rejects.toMatchObject({ status: 400 });
      await expect(checkins.setCheckIn(ada, h.id, "2026-10-31", {}, now)).rejects.toMatchObject({ status: 400 });
      await expect(checkins.setCheckIn(ada, h.id, "2026-02-30", {}, now)).rejects.toMatchObject({ status: 400 });
      await expect(checkins.setCheckIn(ada, h.id, "yesterday", {}, now)).rejects.toMatchObject({ status: 400 });
      await expect(checkins.clearCheckIn(ada, h.id, "2026-10-31", now)).rejects.toMatchObject({ status: 400 });

      // The route says the same.
      const ci = await import("@/app/api/habits/[id]/check-ins/[date]/route");
      asUser(ada);
      const tomorrow = new Date(Date.now() + 36 * 3_600_000).toISOString().slice(0, 10);
      expect((await ci.PUT(json("PUT", {}), ctx({ id: h.id, date: tomorrow }))).status).toBe(400);
      const old = new Date(Date.now() - 9 * 86_400_000).toISOString().slice(0, 10);
      expect((await ci.PUT(json("PUT", {}), ctx({ id: h.id, date: old }))).status).toBe(400);
    });

    it("takes 'today' from the stored zone, not the client or the server", async () => {
      await reset();
      await setZone(ada, "Pacific/Kiritimati"); // UTC+14
      await setZone(ben, "Pacific/Pago_Pago"); // UTC-11
      const ha = await habitIn(ada);
      const hb = await habitIn(ben);
      const instant = at("2026-11-08T12:00:00Z"); // Nov 9 02:00 in Kiritimati, Nov 8 01:00 in Pago Pago
      await expect(checkins.setCheckIn(ada, ha.id, "2026-11-09", {}, instant)).resolves.toBeDefined();
      await expect(checkins.setCheckIn(ada, ha.id, "2026-11-10", {}, instant)).rejects.toMatchObject({ status: 400 });
      await expect(checkins.setCheckIn(ben, hb.id, "2026-11-08", {}, instant)).resolves.toBeDefined();
      await expect(checkins.setCheckIn(ben, hb.id, "2026-11-09", {}, instant)).rejects.toMatchObject({ status: 400 });
    });

    it("leaves one row after two PUTs for the same day, and replaces the value", async () => {
      await reset();
      await setZone(ada, "UTC");
      const h = await habitIn(ada, { name: "Water", kind: "numeric", unit: "glasses", dailyTarget: "8" });
      await checkins.setCheckIn(ada, h.id, "2026-11-08", { value: "3" }, now);
      const second = await checkins.setCheckIn(ada, h.id, "2026-11-08", { value: "8" }, now);
      expect(second).toMatchObject({ value: "8", done: true });
      expect((await sql`select count(*)::int n from check_in where habit_id = ${h.id}`)[0].n).toBe(1);
      // Same request twice through the route.
      const ci = await import("@/app/api/habits/[id]/check-ins/[date]/route");
      asUser(ada);
      const today = new Date().toISOString().slice(0, 10);
      for (let i = 0; i < 2; i++) expect((await ci.PUT(json("PUT", { value: "2.5" }), ctx({ id: h.id, date: today }))).status).toBe(200);
      expect((await sql`select count(*)::int n from check_in where habit_id = ${h.id} and local_date = ${today}`)[0].n).toBe(1);
      expect((await ci.DELETE(json("DELETE"), ctx({ id: h.id, date: today }))).status).toBe(204);
      expect((await ci.DELETE(json("DELETE"), ctx({ id: h.id, date: today }))).status).toBe(204);
      expect((await sql`select count(*)::int n from check_in where habit_id = ${h.id} and local_date = ${today}`)[0].n).toBe(0);
    });

    it("stores 1 for yes/no habits, requires a value for numeric ones, and sets done at write time", async () => {
      await reset();
      await setZone(ada, "UTC");
      const yes = await habitIn(ada);
      const num = await habitIn(ada, { name: "Read", kind: "numeric", unit: "pages", dailyTarget: "20" });
      await expect(checkins.setCheckIn(ada, yes.id, "2026-11-08", { value: "5" }, now)).rejects.toMatchObject({ status: 400 });
      await expect(checkins.setCheckIn(ada, yes.id, "2026-11-08", { value: "1" }, now)).resolves.toMatchObject({ value: "1" });
      await expect(checkins.setCheckIn(ada, num.id, "2026-11-08", {}, now)).rejects.toMatchObject({ status: 400 });
      for (const bad of ["0", "-1", "100001", "1.234", "abc", ""]) {
        await expect(checkins.setCheckIn(ada, num.id, "2026-11-08", { value: bad }, now)).rejects.toBeDefined();
      }
      expect(await checkins.setCheckIn(ada, num.id, "2026-11-08", { value: "19.99" }, now)).toMatchObject({ done: false });
      expect(await checkins.setCheckIn(ada, num.id, "2026-11-07", { value: "20" }, now)).toMatchObject({ done: true });
      expect(await checkins.setCheckIn(ada, num.id, "2026-11-06", { value: 25 }, now)).toMatchObject({ done: true, value: "25" });
    });

    it("does not flip old `done` when the target changes", async () => {
      await reset();
      await setZone(ada, "UTC");
      const h = await habitIn(ada, { name: "Read", kind: "numeric", unit: "pages", dailyTarget: "20" });
      await checkins.setCheckIn(ada, h.id, "2026-11-07", { value: "20" }, now); // done
      await checkins.setCheckIn(ada, h.id, "2026-11-06", { value: "10" }, now); // not done
      await habits.updateHabit(ada, h.id, { updatedAt: h.updatedAt.toISOString(), dailyTarget: "50" });
      let rows = await sql`select local_date::text d, done from check_in where habit_id = ${h.id} order by local_date`;
      expect(rows.map((r) => [r.d, r.done])).toEqual([["2026-11-06", false], ["2026-11-07", true]]);
      const cur = await habits.getHabit(ada, h.id);
      await habits.updateHabit(ada, h.id, { updatedAt: cur.updatedAt.toISOString(), dailyTarget: "5" });
      rows = await sql`select local_date::text d, done from check_in where habit_id = ${h.id} order by local_date`;
      expect(rows.map((r) => [r.d, r.done])).toEqual([["2026-11-06", false], ["2026-11-07", true]]);
      // New writes use the new target.
      expect(await checkins.setCheckIn(ada, h.id, "2026-11-05", { value: "6" }, now)).toMatchObject({ done: true });
    });

    it("refuses the 201st check-in write in an hour", async () => {
      await reset();
      await setZone(ada, "UTC");
      const h = await habitIn(ada);
      for (let i = 0; i < 200; i++) await checkins.setCheckIn(ada, h.id, "2026-11-08", {}, now);
      await expect(checkins.setCheckIn(ada, h.id, "2026-11-08", {}, now)).rejects.toMatchObject({ status: 429 });
      await expect(checkins.clearCheckIn(ada, h.id, "2026-11-08", now)).rejects.toMatchObject({ status: 429 });
      // An hour later the window has moved on.
      await expect(checkins.setCheckIn(ada, h.id, "2026-11-08", {}, at("2026-11-08T16:00:01Z"))).resolves.toBeDefined();
      // Other users are not affected.
      await setZone(ben, "UTC");
      const hb = await habitIn(ben);
      await expect(checkins.setCheckIn(ben, hb.id, "2026-11-08", {}, now)).resolves.toBeDefined();
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  describe("streaks", () => {
    const now = at("2026-11-08T12:00:00Z"); // Sunday 2026-11-08, UTC
    const streakOf = async (u: U, id: string, n = now) => (await progress.streaks(u, n))[id];

    it("counts a day streak ending yesterday while today is still open, and including today", async () => {
      await reset();
      await setZone(ada, "UTC");
      const h = await habitIn(ada); // weekly goal 7: day streak
      await seed(ada, h.id, ["2026-11-05", "2026-11-06", "2026-11-07"]);
      expect(await streakOf(ada, h.id)).toEqual({ mode: "day", current: 3, best: 3 });
      await seed(ada, h.id, ["2026-11-08"]);
      expect(await streakOf(ada, h.id)).toEqual({ mode: "day", current: 4, best: 4 });
    });

    it("breaks a streak on a gap, and keeps the best run", async () => {
      await reset();
      await setZone(ada, "UTC");
      const h = await habitIn(ada);
      await seed(ada, h.id, ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-06", "2026-11-07"]);
      expect(await streakOf(ada, h.id)).toEqual({ mode: "day", current: 2, best: 3 });
      // Last done two days ago: no current streak.
      expect(await streakOf(ada, h.id, at("2026-11-09T12:00:00Z"))).toEqual({ mode: "day", current: 0, best: 3 });
      // Rows that aren't done don't count.
      const h2 = await habitIn(ada, { name: "Numeric", kind: "numeric", unit: "x", dailyTarget: "5" });
      await seed(ada, h2.id, ["2026-11-07", "2026-11-08"], false);
      expect(await streakOf(ada, h2.id)).toEqual({ mode: "day", current: 0, best: 0 });
    });

    it("counts consecutive weeks that met the goal, this week or last", async () => {
      await reset();
      await setZone(ada, "UTC");
      const h = await habitIn(ada, { weeklyGoal: 2 });
      // Weeks of 2026-10-19, 10-26 and 11-02 meet the goal (2 days each); the week of 10-12 has one day.
      await seed(ada, h.id, ["2026-10-12", "2026-10-19", "2026-10-21", "2026-10-26", "2026-10-27", "2026-11-02", "2026-11-04"]);
      // This week (11-02) is met: 3.
      expect(await streakOf(ada, h.id)).toEqual({ mode: "week", current: 3, best: 3 });
      // Next week isn't met yet, but last week was: still 3.
      expect(await streakOf(ada, h.id, at("2026-11-10T12:00:00Z"))).toEqual({ mode: "week", current: 3, best: 3 });
      // Two weeks on, the run ended.
      expect(await streakOf(ada, h.id, at("2026-11-17T12:00:00Z"))).toEqual({ mode: "week", current: 0, best: 3 });
    });

    it("counts a week streak across 2026-W52, 2026-W53 and 2027-W01 as 3", async () => {
      await reset();
      await setZone(ada, "UTC");
      const h = await habitIn(ada, { weeklyGoal: 2 });
      // W51 has one day (not met). W52 starts Mon 2026-12-21, W53 Mon 2026-12-28, 2027-W01 Mon 2027-01-04.
      await seed(ada, h.id, ["2026-12-14", "2026-12-21", "2026-12-22", "2026-12-28", "2026-12-29", "2027-01-04", "2027-01-05"]);
      const s = await streakOf(ada, h.id, at("2027-01-06T12:00:00Z"));
      expect(s).toEqual({ mode: "week", current: 3, best: 3 });
      // 2027-01-01 (a Friday) belongs to 2026-W53: a day there counts for W53, not for a new year.
      const g = await habitIn(ada, { name: "Other", weeklyGoal: 2 });
      await seed(ada, g.id, ["2026-12-21", "2026-12-22", "2026-12-31", "2027-01-01", "2027-01-04", "2027-01-06"]);
      expect(await streakOf(ada, g.id, at("2027-01-07T12:00:00Z"))).toEqual({ mode: "week", current: 3, best: 3 });
    });

    it("keeps a day streak alive over the 23-hour DST day in Denver", async () => {
      await reset();
      await setZone(ada, "America/Denver");
      const h = await habitIn(ada);
      // Check in every evening at 23:30 local, 5 to 9 March 2026 (clocks jump forward on the 8th at 02:00).
      const evenings: [string, string][] = [
        ["2026-03-05", "2026-03-06T06:30:00Z"], // MST, UTC-7
        ["2026-03-06", "2026-03-07T06:30:00Z"],
        ["2026-03-07", "2026-03-08T06:30:00Z"],
        ["2026-03-08", "2026-03-09T05:30:00Z"], // MDT, UTC-6
        ["2026-03-09", "2026-03-10T05:30:00Z"],
      ];
      for (const [date, instant] of evenings) await checkins.setCheckIn(ada, h.id, date, {}, at(instant));
      expect(await streakOf(ada, h.id, at("2026-03-10T05:30:00Z"))).toEqual({ mode: "day", current: 5, best: 5 });
      // Midday the next day, with today still open, it still stands.
      expect(await streakOf(ada, h.id, at("2026-03-10T18:00:00Z"))).toEqual({ mode: "day", current: 5, best: 5 });
      // And the same in the fall: 1 November 2026 has 25 hours.
      const g = await habitIn(ada, { name: "Fall" });
      const fall: [string, string][] = [
        ["2026-10-31", "2026-11-01T05:30:00Z"], // MDT
        ["2026-11-01", "2026-11-02T06:30:00Z"], // MST
        ["2026-11-02", "2026-11-03T06:30:00Z"],
      ];
      for (const [date, instant] of fall) await checkins.setCheckIn(ada, g.id, date, {}, at(instant));
      expect(await streakOf(ada, g.id, at("2026-11-03T06:30:00Z"))).toEqual({ mode: "day", current: 3, best: 3 });
    });

    it("builds the Today view with streak, week dots and counts", async () => {
      await reset();
      await setZone(ada, "UTC");
      const a = await habitIn(ada, { name: "A" });
      const b = await habitIn(ada, { name: "B", weeklyGoal: 2 });
      await seed(ada, a.id, ["2026-11-06", "2026-11-07", "2026-11-08"]);
      await seed(ada, b.id, ["2026-11-02", "2026-11-04"]);
      const t = await progress.today(ada, now);
      expect(t).toMatchObject({ date: "2026-11-08", week: "2026-W45", timeZone: "UTC", total: 2, doneCount: 1 });
      expect(t.habits[0]).toMatchObject({ name: "A", done: true, value: "1", streak: { mode: "day", current: 3 } });
      expect(t.habits[0].week.dots.map((d) => d.done)).toEqual([false, false, false, false, true, true, true]);
      expect(t.habits[1]).toMatchObject({ done: false, value: null, week: { doneDays: 2, goalMet: true }, streak: { mode: "week", current: 1 } });
    });
  });

  // -------------------------------------------------------------------------
  describe("week summary and heatmap", () => {
    it("summarises a week with last week's count, totals and the goal", async () => {
      await reset();
      await setZone(ada, "UTC");
      const read = await habitIn(ada, { name: "Read", kind: "numeric", unit: "pages", dailyTarget: "20", weeklyGoal: 2 });
      const run = await habitIn(ada, { name: "Run", weeklyGoal: 3 });
      await sql`insert into check_in (habit_id, owner_id, local_date, value, done) values
        (${read.id}, ${ada.id}, '2026-11-02', 25, true), (${read.id}, ${ada.id}, '2026-11-03', 10.5, false),
        (${read.id}, ${ada.id}, '2026-11-04', 20, true), (${read.id}, ${ada.id}, '2026-10-27', 30, true)`;
      await seed(ada, run.id, ["2026-11-02"]);
      const s = await progress.weekSummary(ada, "2026-W45", at("2026-11-08T12:00:00Z"));
      expect(s).toMatchObject({ week: "2026-W45", monday: "2026-11-02", sunday: "2026-11-08", prev: "2026-W44", next: null, isCurrent: true, daysElapsed: 7 });
      const r = s.habits.find((h) => h.name === "Read")!;
      expect(r).toMatchObject({ doneDays: 2, total: "55.5", goalMet: true, lastWeekDoneDays: 1, dailyTarget: "20" });
      expect(r.values).toEqual(["25", "10.5", "20", null, null, null, null]);
      expect(s.habits.find((h) => h.name === "Run")).toMatchObject({ doneDays: 1, goalMet: false });
      expect(s.totals).toEqual({ habits: 2, habitsOnGoal: 1, checkIns: 3, completionPct: Math.round((100 * 3) / 5) });
      const mid = await progress.weekSummary(ada, null, at("2026-11-04T12:00:00Z"));
      expect(mid).toMatchObject({ week: "2026-W45", daysElapsed: 3 });
    });

    it("answers GET /api/progress/week?week=2026-W53 with its Monday and Sunday, and its prev/next round-trip", async () => {
      await reset();
      await setZone(ada, "UTC");
      const h = await habitIn(ada, { weeklyGoal: 2 });
      await seed(ada, h.id, ["2026-12-28", "2027-01-01"]);
      const route = await import("@/app/api/progress/week/route");
      asUser(ada);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(at("2027-01-06T12:00:00Z")); // inside 2027-W01
      const get = async (w: string) => route.GET(new Request(`http://localhost:3000/api/progress/week?week=${w}`));

      const res = await get("2026-W53");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { week: string; monday: string; sunday: string; prev: string; next: string; habits: { doneDays: number }[] };
      expect(body).toMatchObject({ week: "2026-W53", monday: "2026-12-28", sunday: "2027-01-03", prev: "2026-W52", next: "2027-W01" });
      expect(body.habits[0].doneDays).toBe(2); // 2027-01-01 is in 2026-W53
      for (const w of [body.prev, body.next]) {
        const r = (await (await get(w)).json()) as { week: string };
        expect(r.week).toBe(w);
      }
      const next = (await (await get(body.next)).json()) as { prev: string; next: string | null; isCurrent: boolean };
      expect(next).toMatchObject({ prev: "2026-W53", next: null, isCurrent: true });

      expect((await get("2027-W53")).status).toBe(400);
      expect((await get("2026-W54")).status).toBe(400);
      expect((await get("2026-W00")).status).toBe(400);
      expect((await get("garbage")).status).toBe(400);
      expect((await get("2027-W02")).status).toBe(400); // the future
      expect((await get("2026-W01")).status).toBe(400); // 52 weeks back: outside the window
      expect((await get("2026-W03")).status).toBe(200); // 51 weeks back: the oldest
    });

    it("limits the weeks to the current one and the 51 before it", async () => {
      await reset();
      await setZone(ada, "UTC");
      const t = at("2026-11-08T12:00:00Z"); // 2026-W45
      await expect(progress.weekSummary(ada, "2025-W46", t)).resolves.toMatchObject({ prev: null }); // 51 weeks back: the oldest
      await expect(progress.weekSummary(ada, "2025-W45", t)).rejects.toMatchObject({ status: 400 });
      await expect(progress.weekSummary(ada, "2026-W46", t)).rejects.toMatchObject({ status: 400 });
      expect((await progress.weekSummary(ada, "2026-W44", t)).next).toBe("2026-W45");
    });

    it("builds a 30-day heatmap with intensity 0 to 4, and a per-habit one", async () => {
      await reset();
      await setZone(ada, "UTC");
      const now = at("2026-11-08T12:00:00Z");
      await sql`insert into habit (id, owner_id, name, kind, weekly_goal, position, created_at) values
        ('00000000-0000-4000-8000-0000000000a1', ${ada.id}, 'A', 'check', 7, 0, '2026-01-01'),
        ('00000000-0000-4000-8000-0000000000a2', ${ada.id}, 'B', 'check', 7, 1, '2026-01-01'),
        ('00000000-0000-4000-8000-0000000000a3', ${ada.id}, 'C', 'check', 7, 2, '2026-01-01'),
        ('00000000-0000-4000-8000-0000000000a4', ${ada.id}, 'D', 'check', 7, 3, '2026-11-08')`;
      const [a, b, c, d] = ["a1", "a2", "a3", "a4"].map((s) => `00000000-0000-4000-8000-0000000000${s}`);
      await sql`insert into check_in (habit_id, owner_id, local_date) values
        (${a}, ${ada.id}, '2026-11-07'), (${b}, ${ada.id}, '2026-11-07'), (${c}, ${ada.id}, '2026-11-07'),
        (${a}, ${ada.id}, '2026-11-06'), (${b}, ${ada.id}, '2026-11-06'),
        (${a}, ${ada.id}, '2026-11-05'),
        (${d}, ${ada.id}, '2026-11-08')`;
      const h = await progress.heatmap(ada, {}, now);
      expect(h).toMatchObject({ from: "2026-10-10", to: "2026-11-08", habitId: null });
      expect(h.days).toHaveLength(30);
      const day = (date: string) => h.days.find((x) => x.date === date)!;
      expect(day("2026-11-07")).toMatchObject({ done: 3, total: 3, intensity: 4 });
      expect(day("2026-11-06")).toMatchObject({ done: 2, total: 3, intensity: 2 });
      expect(day("2026-11-05")).toMatchObject({ done: 1, total: 3, intensity: 1 });
      expect(day("2026-11-04")).toMatchObject({ done: 0, total: 3, intensity: 0 });
      // D was created on the 8th: it counts only from that day, and a lone check-in on a day with 4 habits.
      expect(day("2026-11-08")).toMatchObject({ done: 1, total: 4, intensity: 1 });

      const one = await progress.heatmap(ada, { habitId: a }, now);
      expect(one.habitId).toBe(a);
      expect(one.days.filter((x) => x.intensity === 4).map((x) => x.date)).toEqual(["2026-11-05", "2026-11-06", "2026-11-07"]);
      await expect(progress.heatmap(ben, { habitId: a }, now)).rejects.toMatchObject({ status: 404 });
      await expect(progress.heatmap(root, { habitId: a }, now)).rejects.toMatchObject({ status: 404 });
      await expect(progress.heatmap(ada, { days: 0 }, now)).rejects.toBeDefined();
      await expect(progress.heatmap(ada, { days: 91 }, now)).rejects.toBeDefined();
    });

    it("gives the habit detail: streak, 8-week hit rate and the editable days", async () => {
      await reset();
      await setZone(ada, "UTC");
      const h = await habitIn(ada, { weeklyGoal: 2 });
      await seed(ada, h.id, ["2026-11-02", "2026-11-03", "2026-10-26", "2026-10-27", "2026-11-08"]);
      const p = await progress.habitProgress(ada, h.id, at("2026-11-08T12:00:00Z"));
      expect(p.weeks).toHaveLength(8);
      expect(p.weeks.at(-1)).toMatchObject({ week: "2026-W45", doneDays: 3, goalMet: true });
      expect(p.hitRate).toBe(2 / 8);
      expect(p.streak).toMatchObject({ mode: "week", current: 2 });
      expect(p.recent).toHaveLength(8);
      expect(p.recent[0]).toMatchObject({ date: "2026-11-08", done: true });
      await expect(progress.habitProgress(ben, h.id)).rejects.toMatchObject({ status: 404 });
    });
  });

  // -------------------------------------------------------------------------
  describe("query plans", () => {
    it("uses the primary key or the covering index, never a sequential scan of check_in, with 10,000 rows", async () => {
      await reset();
      await sql`delete from "user" where id like 'hb-x%'`;
      await sql`insert into "user" (id, name, email) select 'hb-x' || g, 'x', 'hb-x' || g || '@test.local' from generate_series(1, 50) g`;
      await sql`insert into habit (id, owner_id, name, kind, weekly_goal, position, created_at)
        select gen_random_uuid(), 'hb-x' || u, 'h' || h, 'check', 5, h, '2026-01-01' from generate_series(1, 50) u, generate_series(0, 3) h`;
      await sql`insert into check_in (habit_id, owner_id, local_date, value, done)
        select h.id, h.owner_id, d::date, 1, true from habit h, generate_series('2026-09-01'::date, '2026-10-20'::date, interval '1 day') d
        where h.owner_id like 'hb-x%'`;
      expect((await sql`select count(*)::int n from check_in where owner_id like 'hb-x%'`)[0].n).toBe(10_000);
      await sql`vacuum analyze check_in`;
      await sql`analyze habit`;

      const owner = "hb-x7";
      const [{ id: habitId }] = await sql`select id from habit where owner_id = ${owner} limit 1`;
      const explain = async (q: ReturnType<typeof progress.weekQuery>) => {
        const rows = await dbm.db().execute<Record<string, string>>(dsql`explain ${q}`);
        return rows.map((r) => r["QUERY PLAN"]).join("\n");
      };
      const plans = {
        week: await explain(progress.weekQuery(owner, "UTC", "2026-10-12", "2026-10-18")),
        heatmap: await explain(progress.heatmapQuery(owner, "UTC", "2026-09-20", "2026-10-19")),
        habitHeatmap: await explain(progress.habitHeatmapQuery(owner, habitId, "2026-09-20", "2026-10-19")),
        streaks: await explain(progress.streakIslandsQuery(owner, "2026-01-01")),
      };
      for (const [name, plan] of Object.entries(plans)) {
        expect(plan, `${name}\n${plan}`).not.toMatch(/Seq Scan on check_in/);
        expect(plan, `${name}\n${plan}`).toMatch(/check_in_habit_id_local_date_pk|check_in_owner_date_covering_idx/);
      }
      expect(plans.heatmap).toMatch(/check_in_owner_date_covering_idx/);
      await sql`delete from "user" where id like 'hb-x%'`;
    });
  });

  // -------------------------------------------------------------------------
  describe("settings route", () => {
    it("creates settings from the browser zone on the first GET, then PATCHes within the limits", async () => {
      await reset();
      const route = await import("@/app/api/settings/route");
      asUser(ada);
      const first = await route.GET(new Request("http://localhost:3000/api/settings?detectedZone=Europe/London"));
      expect(((await first.json()) as { settings: { timeZone: string } }).settings.timeZone).toBe("Europe/London");
      const again = await route.GET(new Request("http://localhost:3000/api/settings?detectedZone=Asia/Tokyo"));
      expect(((await again.json()) as { settings: { timeZone: string } }).settings.timeZone).toBe("Europe/London");
      const patch = await route.PATCH(json("PATCH", { timeZone: "Asia/Kolkata", reminderTime: "20:15" }));
      expect(patch.status).toBe(200);
      expect(((await patch.json()) as { settings: { reminderTime: string } }).settings.reminderTime).toBe("20:15");
      expect((await route.PATCH(json("PATCH", { reminderTime: "20:10" }))).status).toBe(400);
      expect((await route.PATCH(json("PATCH", { timeZone: "Mars/Olympus" }))).status).toBe(400);
      expect((await route.PATCH(json("PATCH", { timeZone: "UTC" }))).status).toBe(200);
      expect((await route.PATCH(json("PATCH", { timeZone: "Europe/Paris" }))).status).toBe(200);
      expect((await route.PATCH(json("PATCH", { timeZone: "Asia/Tokyo" }))).status).toBe(429);
      asUser(ben);
      expect(((await (await route.GET(new Request("http://localhost:3000/api/settings"))).json()) as { settings: { timeZone: string } }).settings.timeZone).toBe("UTC");
      // The zone drives "today" for the data layer.
      expect((await settings.getLocalDay(ada, at("2026-11-08T23:30:00Z"))).today).toBe("2026-11-09"); // Paris, UTC+1
    });
  });

  // -------------------------------------------------------------------------
  describe("admin counts", () => {
    it("returns numbers only, with no names, emails or habit text, and only to admins", async () => {
      await reset();
      await setZone(ada, "UTC");
      const secret = await habitIn(ada, { name: "Stop drinking" });
      await checkins.setCheckIn(ada, secret.id, new Date().toISOString().slice(0, 10));
      const counts = await progress.adminCounts(root);
      expect(counts.users).toBeGreaterThanOrEqual(3);
      expect(counts.activeHabits).toBeGreaterThanOrEqual(1);
      expect(counts.checkInsToday).toBeGreaterThanOrEqual(1);
      const text = JSON.stringify(counts);
      for (const needle of ["Stop drinking", ada.name, ada.email, ada.id, "hb-", "@"]) expect(text).not.toContain(needle);
      const leaves: unknown[] = [];
      (function walk(v: unknown) {
        if (v !== null && typeof v === "object") Object.values(v).forEach(walk);
        else leaves.push(v);
      })(counts);
      // Every leaf is a number, or one of the fixed usage labels, or a null cap.
      for (const leaf of leaves) expect(typeof leaf === "number" || leaf === null || ["push", "coach", "demo_load"].includes(leaf as string)).toBe(true);
      expect(counts.usage.find((u) => u.kind === "push")?.cap).toBe(2000);

      await expect(progress.adminCounts(ada)).rejects.toMatchObject({ status: 403 });
      const route = await import("@/app/api/admin/stats/route");
      asUser(ada);
      expect((await route.GET()).status).toBe(403);
      asUser(root);
      const res = await route.GET();
      expect(res.status).toBe(200);
      expect(JSON.stringify(await res.json())).not.toContain("Stop drinking");
      asUser(null);
      expect((await route.GET()).status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  describe("admin cannot impersonate or set passwords (Better Auth)", () => {
    it("fails both calls, creates no session for the user, and the user's password still works", async () => {
      const { auth } = await import("@/lib/auth");
      const handler = auth().handler;
      const call = (path: string, body: unknown, cookie?: string) =>
        handler(
          new Request(`http://localhost:3000/api/auth${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
            body: JSON.stringify(body),
          }),
        );
      const signUp = async (n: string) => {
        const res = await call("/sign-up/email", { name: n, email: `hb-auth-${n}@test.local`, password: PASSWORD });
        expect(res.status).toBe(200);
        return ((await res.json()) as { user: { id: string } }).user.id;
      };
      const signIn = async (n: string, password = PASSWORD) => {
        const res = await call("/sign-in/email", { email: `hb-auth-${n}@test.local`, password });
        return res.status === 200 ? res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") : null;
      };
      const adminId = await signUp("admin");
      const userId = await signUp("a");
      await sql`update "user" set role = 'admin' where id = ${adminId}`;
      const cookie = (await signIn("admin"))!;
      expect(cookie).toBeTruthy();
      const sessions = async () => (await sql`select count(*)::int n from session where user_id = ${userId}`)[0].n as number;
      const before = await sessions();

      const imp = await call("/admin/impersonate-user", { userId }, cookie);
      expect([403, 404]).toContain(imp.status);
      expect(imp.headers.getSetCookie().join(";")).not.toContain("session_token");
      const setPw = await call("/admin/set-user-password", { userId, newPassword: "attacker-chosen-pass" }, cookie);
      expect([403, 404]).toContain(setPw.status);

      expect(await sessions()).toBe(before);
      expect((await sql`select count(*)::int n from session where impersonated_by is not null`)[0].n).toBe(0);
      expect(await signIn("a", "attacker-chosen-pass")).toBeNull();
      expect(await signIn("a")).toBeTruthy();
    });
  });
});
