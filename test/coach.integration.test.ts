/**
 * The weekly coach against a real Postgres (TEST_DATABASE_URL), with `generate()` wrapped so calls can be counted
 * and, where a test needs it, replaced. Covers caching, the refresh cap, the hourly and daily caps under a race,
 * week limits, owner-only access, provider failures and that no log line carries a habit name or value.
 */
import postgres from "postgres";
import { AiError } from "@/lib/ai/types";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;

const state = vi.hoisted(() => ({
  user: null as null | { id: string; role: "user" | "admin"; name: string; email: string },
  generate: vi.fn(),
}));

vi.mock("@/lib/ai", async (orig) => {
  const actual = await orig<typeof import("@/lib/ai")>();
  state.generate.mockImplementation(actual.generate);
  return { ...actual, generate: state.generate };
});

vi.mock("@/lib/auth/session", async () => {
  const { UnauthorizedError } = await import("@/lib/auth/rbac");
  return {
    requireUser: async () => {
      if (!state.user) throw new UnauthorizedError();
      return state.user;
    },
  };
});

type U = { id: string; role: "user" | "admin"; name: string; email: string };
const NOW = new Date("2026-11-04T12:00:00Z"); // a Wednesday: ISO week 2026-W45 (Mon 2 Nov)
const W45 = "2026-W45";
const W44 = "2026-W44";
const SECRET = "ZZ-Secret-Name";

describe.skipIf(!url)("weekly coach (Postgres)", () => {
  let sql: postgres.Sql;
  let coach: typeof import("@/lib/coach");
  let habits: typeof import("@/lib/habits");
  let checkins: typeof import("@/lib/checkins");
  let envMod: typeof import("@/lib/env");
  let route: typeof import("@/app/api/coach/route");
  let actualGenerate: typeof import("@/lib/ai").generate;
  const logged: string[] = [];

  const mk = (id: string, role: "user" | "admin" = "user"): U => ({ id: `co-${id}`, role, name: id, email: `co-${id}@test.local` });
  const ada = mk("ada");
  const ben = mk("ben");
  const root = mk("root", "admin");
  const racers = Array.from({ length: 6 }, (_, i) => mk(`r${i}`));
  const all = [ada, ben, root, ...racers];

  async function clean() {
    await sql`delete from habit where owner_id like 'co-%'`;
    await sql`delete from coach_summary where user_id like 'co-%'`;
    await sql`delete from coach_claim where user_id like 'co-%'`;
    await sql`delete from user_settings where user_id like 'co-%'`;
    await sql`delete from rate_event where user_id like 'co-%'`;
    await sql`delete from daily_usage`;
  }

  /** A habit with check-ins on the given dates (Wed 4 Nov is "today" at NOW). */
  async function habitWith(u: U, name: string, dates: string[], over: Record<string, unknown> = {}) {
    const h = await habits.createHabit(u, { name, weeklyGoal: 3, ...over });
    // Created "weeks ago", so the pinned clock can back-fill into it.
    await sql`update habit set created_at = '2026-09-01T00:00:00Z' where id = ${h.id}`;
    for (const d of dates) await checkins.setCheckIn(u, h.id, d, {}, NOW);
    return h;
  }
  const rateCount = async (u: U) => Number((await sql`select count(*) n from rate_event where user_id = ${u.id} and kind = 'coach'`)[0].n);
  const dailyCoach = async () => Number((await sql`select coalesce(sum(count), 0) n from daily_usage where kind = 'coach'`)[0].n);
  const post = (u: U, week?: string) => coach.generateCoach(u, week ?? null, NOW);

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.AI_PROVIDER = "demo";
    process.env.LOG_LEVEL = "info";
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    for (const u of all) {
      await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.name}, ${u.email}, ${u.role}) on conflict do nothing`;
    }
    coach = await import("@/lib/coach");
    habits = await import("@/lib/habits");
    checkins = await import("@/lib/checkins");
    envMod = await import("@/lib/env");
    route = await import("@/app/api/coach/route");
    actualGenerate = (await vi.importActual<typeof import("@/lib/ai")>("@/lib/ai")).generate;
    for (const m of ["log", "error"] as const) {
      vi.spyOn(console, m).mockImplementation((line: unknown) => void logged.push(String(line)));
    }
  });

  afterAll(async () => {
    await sql`delete from "user" where id like 'co-%'`;
    await sql.end();
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    await clean();
    state.generate.mockReset();
    state.generate.mockImplementation(actualGenerate);
    state.user = null;
    logged.length = 0;
  });

  afterEach(() => {
    delete process.env.COACH_DAILY_CAP;
    process.env.AI_PROVIDER = "demo";
    envMod.resetEnvCache();
  });

  // -------------------------------------------------------------------------

  it("makes no model call for a week with no check-ins and stores the fresh-start message", async () => {
    await habitWith(ada, "Read", []);
    const r = await post(ada);
    expect(r.week).toBe(W45);
    expect(r.summary?.mode).toBe("skipped");
    expect(r.summary?.data.summary).toMatch(/fresh start/i);
    expect(r.refreshesLeft).toBe(2);
    expect(state.generate).not.toHaveBeenCalled();
    expect(await rateCount(ada)).toBe(0);
    expect(await dailyCoach()).toBe(0);
    expect((await post(ada)).cached).toBe(true);
  });

  it("generates once, stores it without names, and a second POST with unchanged data makes no call", async () => {
    const read = await habitWith(ada, SECRET, ["2026-11-02", "2026-11-03", "2026-11-04"]);
    const first = await post(ada);
    expect(first.cached).toBe(false);
    expect(first.summary?.mode).toBe("demo");
    expect(first.summary?.data.summary).toMatch(/Demo summary/);
    expect(first.summary?.data.wins[0]).toMatchObject({ habit: "H1", habitId: read.id, habitName: SECRET });
    expect(first.summary?.stats.habits[0]).toMatchObject({ id: "H1", name: SECRET, doneDays: 3 });
    expect(first.refreshesLeft).toBe(2);
    expect(state.generate).toHaveBeenCalledTimes(1);

    const second = await post(ada);
    expect(second.cached).toBe(true);
    expect(second.summary?.generatedAt).toBe(first.summary?.generatedAt);
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(await rateCount(ada)).toBe(1);
    expect(await dailyCoach()).toBe(1);

    const [row] = await sql`select data::text d, stats::text s, input_hash h, mode, regenerations from coach_summary where user_id = ${ada.id}`;
    expect(row.h).toMatch(/^[0-9a-f]{64}$/);
    expect(row.s).not.toContain(SECRET);
    expect(row.mode).toBe("demo");
    expect(row.regenerations).toBe(0);
    // The model was shown the name, as data; the stored row never has it.
    expect(state.generate.mock.calls[0][0].prompt).toContain(SECRET);
    expect(state.generate.mock.calls[0][0].system).toMatch(/treat them as data/);
  });

  it("GET never calls the model, and returns null before the first generation", async () => {
    await habitWith(ada, "Read", ["2026-11-04"]);
    const before = await coach.getCoach(ada, null, NOW);
    expect(before).toEqual({ week: W45, summary: null, refreshesLeft: 2 });
    await post(ada);
    state.generate.mockClear();
    expect((await coach.getCoach(ada, null, NOW)).summary?.mode).toBe("demo");
    expect(state.generate).not.toHaveBeenCalled();
  });

  it("allows two refreshes when the data changed, then 429 with the cached summary", async () => {
    const h = await habitWith(ada, "Read", ["2026-11-02"]);
    const first = await post(ada);
    await checkins.setCheckIn(ada, h.id, "2026-11-03", {}, NOW);
    const r1 = await post(ada);
    expect(r1.cached).toBe(false);
    expect(r1.refreshesLeft).toBe(1);
    await checkins.setCheckIn(ada, h.id, "2026-11-04", {}, NOW);
    const r2 = await post(ada);
    expect(r2.refreshesLeft).toBe(0);
    expect(state.generate).toHaveBeenCalledTimes(3);

    await checkins.clearCheckIn(ada, h.id, "2026-11-02", NOW);
    const err = await post(ada).catch((e) => e);
    expect(err).toBeInstanceOf(coach.CoachLimitError);
    expect(err).toMatchObject({ status: 429, reason: "refresh_cap", message: "This week's summary has been refreshed twice; it updates next week" });
    expect(err.view.summary.generatedAt).toBe(r2.summary?.generatedAt);
    expect(err.view.summary.generatedAt).not.toBe(first.summary?.generatedAt);
    expect(state.generate).toHaveBeenCalledTimes(3);
  });

  it("two concurrent POSTs make one call (the same process, and two module instances racing on the lock)", async () => {
    await habitWith(ada, "Read", ["2026-11-02", "2026-11-03"]);
    const gate = vi.fn(async (req: unknown) => {
      await new Promise((r) => setTimeout(r, 150));
      return actualGenerate(req as never);
    });
    state.generate.mockImplementation(gate);
    const [a, b] = await Promise.all([post(ada), post(ada)]);
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(a.summary?.generatedAt).toBe(b.summary?.generatedAt);

    // A second module instance has its own in-process map: only the advisory lock can serialise these.
    await sql`delete from coach_summary where user_id = ${ada.id}`;
    await sql`delete from rate_event where user_id = ${ada.id}`;
    state.generate.mockClear();
    vi.resetModules();
    const other = await import("@/lib/coach");
    expect(other).not.toBe(coach);
    const results = await Promise.allSettled([coach.generateCoach(ada, null, NOW), other.generateCoach(ada, null, NOW), other.generateCoach(ada, null, NOW)]);
    expect(state.generate).toHaveBeenCalledTimes(1);
    // The loser in the other instance holds no in-process dedupe: it is turned away by the claim (409) or sees the stored row.
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toMatchObject({ status: 409 });
    }
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(await rateCount(ada)).toBe(1);
    expect(Number((await sql`select count(*) n from coach_claim`)[0].n)).toBe(0);
  });

  it("the hourly cap (6) holds when requests race", async () => {
    await habitWith(ada, "Read", ["2026-11-02"]);
    await habitWith(ada, "Walk", ["2026-10-28"]);
    // Five calls already this hour: only one of two concurrent weeks may still go through.
    for (let i = 0; i < 5; i++) await sql`insert into rate_event (user_id, kind) values (${ada.id}, 'coach')`;
    const results = await Promise.allSettled([post(ada, W45), post(ada, W44)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 429, reason: "hourly" });
    expect(await rateCount(ada)).toBe(6);
    expect(state.generate).toHaveBeenCalledTimes(1);
  });

  it("the app-wide daily cap holds when users race, and a refused request spends nothing", async () => {
    process.env.COACH_DAILY_CAP = "2";
    envMod.resetEnvCache();
    for (const u of racers) await habitWith(u, "Read", ["2026-11-02"]);
    const results = await Promise.allSettled(racers.map((u) => post(u)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(refused).toHaveLength(4);
    for (const r of refused) expect(r.reason).toMatchObject({ status: 429, reason: "daily_cap" });
    expect(await dailyCoach()).toBe(2);
    expect(state.generate).toHaveBeenCalledTimes(2);
    const spent = Number((await sql`select count(*) n from rate_event where user_id like 'co-r%' and kind = 'coach'`)[0].n);
    expect(spent).toBe(2); // the four refused requests rolled their rate event back
    expect(Number((await sql`select count(*) n from coach_summary where user_id like 'co-r%'`)[0].n)).toBe(2);
  });

  it("covers this week and last week only", async () => {
    await habitWith(ada, "Walk", ["2026-10-28"]);
    expect((await post(ada, W44)).week).toBe(W44);
    for (const bad of ["2026-W43", "2026-W46", "2027-W53", "nonsense", "2026-W45 "]) {
      await expect(post(ada, bad)).rejects.toMatchObject({ status: 400 });
      await expect(coach.getCoach(ada, bad, NOW)).rejects.toMatchObject({ status: 400 });
    }
  });

  it("uses the user's own time zone for 'this week'", async () => {
    await sql`insert into user_settings (user_id, time_zone) values (${ada.id}, 'Pacific/Auckland')`;
    const sundayEvening = new Date("2026-11-08T20:00:00Z"); // already Monday 9 Nov in Auckland
    expect((await coach.getCoach(ada, null, sundayEvening)).week).toBe("2026-W46");
    expect((await coach.getCoach(ben, null, sundayEvening)).week).toBe(W45);
  });

  it("is owner only: nobody else, an admin included, can read or change someone's summary", async () => {
    await habitWith(ben, SECRET, ["2026-11-03"]);
    await post(ben);
    for (const other of [ada, root]) {
      expect(await coach.getCoach(other, null, NOW)).toEqual({ week: W45, summary: null, refreshesLeft: 2 });
    }
    // Admin generating gets their own (empty) week and never touches ben's row.
    const r = await post(root);
    expect(r.summary?.mode).toBe("skipped");
    expect(JSON.stringify(r)).not.toContain(SECRET);
    const rows = await sql`select user_id from coach_summary order by user_id`;
    expect(rows.map((x) => x.user_id)).toEqual([ben.id, root.id]);
    // Habit names in a view are looked up for the owner only: after the habit is gone the summary says so.
    await sql`delete from habit where owner_id = ${ben.id}`;
    expect((await coach.getCoach(ben, null, NOW)).summary?.data.wins[0]).toMatchObject({ habitId: expect.any(String), habitName: null });
  });

  it("route: 401 signed out, 403 cross-origin, 400 bad body, week limits", async () => {
    const req = (method: string, body?: unknown, origin = "http://localhost:3000") =>
      new Request("http://localhost:3000/api/coach", { method, headers: { origin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    expect((await route.GET(req("GET"))).status).toBe(401);
    expect((await route.POST(req("POST", {}))).status).toBe(401);
    state.user = ada;
    expect((await route.POST(req("POST", {}, "https://evil.example"))).status).toBe(403);
    expect((await route.POST(req("POST", { week: 5 }))).status).toBe(400);
    expect((await route.POST(req("POST", { week: "2020-W01" }))).status).toBe(400);
    expect((await route.POST(req("POST", { week: "2026-W45", extra: 1 }))).status).toBe(400);
    const get = await route.GET(new Request("http://localhost:3000/api/coach"));
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ summary: null, refreshesLeft: 2 });
  });

  it("a provider outage returns the AiError, stores nothing, releases the claim and refunds both caps", async () => {
    await habitWith(ada, "Read", ["2026-11-02"]);
    state.generate.mockRejectedValue(new AiError("Model quota reached", "quota", 429));
    await expect(post(ada)).rejects.toMatchObject({ kind: "quota" });
    expect(Number((await sql`select count(*) n from coach_summary`)[0].n)).toBe(0);
    expect(Number((await sql`select count(*) n from coach_claim`)[0].n)).toBe(0);
    expect(await rateCount(ada)).toBe(0);
    expect(await dailyCoach()).toBe(0);
    // Retrying once the provider is back works, and counts as the first generation, not a refresh.
    state.generate.mockImplementation(actualGenerate);
    const ok = await post(ada);
    expect(ok.refreshesLeft).toBe(2);
    expect(await rateCount(ada)).toBe(1);
  });

  it("a failed refresh keeps the existing summary and its counts", async () => {
    const h = await habitWith(ada, "Read", ["2026-11-02"]);
    const first = await post(ada);
    await checkins.setCheckIn(ada, h.id, "2026-11-03", {}, NOW);
    state.generate.mockRejectedValue(new AiError("Model provider unreachable", "provider"));
    await expect(post(ada)).rejects.toMatchObject({ kind: "provider" });
    const kept = await coach.getCoach(ada, null, NOW);
    expect(kept.summary?.generatedAt).toBe(first.summary?.generatedAt);
    expect(kept.refreshesLeft).toBe(2);
    expect(await rateCount(ada)).toBe(1);
    expect(await dailyCoach()).toBe(1);
  });

  it("a live provider's failure answered from the demo fixture is an error, not a cached summary", async () => {
    await habitWith(ada, "Read", ["2026-11-02", "2026-11-03"]);
    process.env.AI_PROVIDER = "gemini";
    process.env.GEMINI_API_KEY = "test-key";
    process.env.AI_FALLBACK_TO_DEMO = "true";
    envMod.resetEnvCache();
    const fetchStub = vi.fn(async () => new Response("quota", { status: 429 }));
    vi.stubGlobal("fetch", fetchStub);
    try {
      await expect(post(ada)).rejects.toMatchObject({ kind: "provider" });
      expect(fetchStub).toHaveBeenCalled();
      expect(Number((await sql`select count(*) n from coach_summary`)[0].n)).toBe(0);
      expect(await rateCount(ada)).toBe(0);
      expect(await dailyCoach()).toBe(0);

      // And plain demo mode still works afterwards.
      process.env.AI_PROVIDER = "demo";
      envMod.resetEnvCache();
      const demoFirst = await post(ada);
      expect(demoFirst.summary?.mode).toBe("demo");
    } finally {
      vi.unstubAllGlobals();
      delete process.env.GEMINI_API_KEY;
      delete process.env.AI_FALLBACK_TO_DEMO;
    }
  });

  it("unchecking everything and checking back in cannot loop the call cap", async () => {
    const h = await habitWith(ada, "Read", []);
    const days = ["2026-11-02", "2026-11-03", "2026-11-04"];
    const results: string[] = [];
    for (let round = 0; round < 5; round++) {
      await checkins.setCheckIn(ada, h.id, days[0], {}, NOW);
      try {
        results.push((await post(ada)).summary?.mode ?? "none");
      } catch (err) {
        results.push(`${(err as { reason?: string }).reason ?? "error"}`);
      }
      await checkins.clearCheckIn(ada, h.id, days[0], NOW);
      try {
        await post(ada); // the week is empty again: stores the fresh-start message, no call
      } catch (err) {
        results.push(`empty:${(err as { reason?: string }).reason ?? "error"}`);
      }
    }
    expect(state.generate).toHaveBeenCalledTimes(3);
    expect(results.filter((r) => r === "refresh_cap").length).toBeGreaterThanOrEqual(2);
    const [row] = await sql`select mode, model_calls, regenerations from coach_summary where user_id = ${ada.id}`;
    expect(row.model_calls).toBe(3);
    expect(row.mode).toBe("skipped");
    // Checking in a different way doesn't help either.
    await checkins.setCheckIn(ada, h.id, days[1], {}, NOW);
    await expect(post(ada)).rejects.toMatchObject({ status: 429, reason: "refresh_cap" });
    expect(state.generate).toHaveBeenCalledTimes(3);
  });

  describe("claims: no lock is held through the model call", () => {
    it("two different users generating at the same time do not serialize", async () => {
      await habitWith(ada, "Read", ["2026-11-02"]);
      await habitWith(ben, "Walk", ["2026-11-02"]);
      // Each call waits until the other has started. If one user's request held a lock the other needed
      // (the daily_usage row, say), this would never resolve and the test would time out.
      const started: string[] = [];
      let release!: () => void;
      const both = new Promise<void>((r) => (release = r));
      state.generate.mockImplementation(async (req: never) => {
        started.push("x");
        if (started.length === 2) release();
        await both;
        return actualGenerate(req);
      });
      const [a, b] = await Promise.all([post(ada), post(ben)]);
      expect(a.summary?.mode).toBe("demo");
      expect(b.summary?.mode).toBe("demo");
      expect(state.generate).toHaveBeenCalledTimes(2);
      expect(await dailyCoach()).toBe(2);
    }, 10_000);

    it("a model call holds no open transaction", async () => {
      await habitWith(ada, "Read", ["2026-11-02"]);
      let idleInTx = -1;
      state.generate.mockImplementation(async (req: never) => {
        const rows = await sql`select count(*) n from pg_stat_activity where datname = current_database() and state like 'idle in transaction%'`;
        idleInTx = Number(rows[0].n);
        return actualGenerate(req);
      });
      await post(ada);
      expect(idleInTx).toBe(0);
    });

    it("a fresh claim turns a second request away with 409, and a stale one (over 45 s) is taken over", async () => {
      await habitWith(ada, "Read", ["2026-11-02"]);
      await sql`insert into coach_claim (user_id, iso_week, token) values (${ada.id}, ${W45}, gen_random_uuid())`;
      await expect(post(ada)).rejects.toMatchObject({ status: 409 });
      expect(state.generate).not.toHaveBeenCalled();
      expect(await rateCount(ada)).toBe(0);
      expect(await dailyCoach()).toBe(0);

      await sql`update coach_claim set claimed_at = now() - interval '46 seconds' where user_id = ${ada.id}`;
      const r = await post(ada);
      expect(r.summary?.mode).toBe("demo");
      expect(Number((await sql`select count(*) n from coach_claim`)[0].n)).toBe(0);
    });

    it("unchecking everything during a paid call cannot dodge the cap, over 8 rounds", async () => {
      const h = await habitWith(ada, "Read", [], { kind: "numeric", unit: "pages", dailyTarget: "100" });
      vi.resetModules();
      const other = await import("@/lib/coach");
      state.generate.mockImplementation(async (req: never) => {
        await new Promise((r) => setTimeout(r, 300));
        return actualGenerate(req);
      });
      const outcomes: string[] = [];
      for (let round = 1; round <= 8; round++) {
        await checkins.setCheckIn(ada, h.id, "2026-11-02", { value: String(round) }, NOW); // different data every round
        const slow = post(ada).then(
          (r) => `ok:${r.summary?.mode}`,
          (e) => `err:${(e as { reason?: string; status?: number }).reason ?? (e as { status?: number }).status}`,
        );
        await new Promise((r) => setTimeout(r, 100)); // the model call is now in flight
        await checkins.clearCheckIn(ada, h.id, "2026-11-02", NOW);
        // The same week, empty, mid-call: it must not write "skipped" under the running call.
        await other.generateCoach(ada, null, NOW).catch(() => undefined);
        const [mid] = await sql`select mode from coach_summary where user_id = ${ada.id}`;
        // (Once the cap is reached no call is in flight any more, and an empty week is rightly stored as skipped.)
        if (round <= 3 && mid) expect(mid.mode).not.toBe("skipped");
        outcomes.push(await slow);
      }
      const paid = state.generate.mock.calls.length;
      expect(paid).toBe(3);
      const [row] = await sql`select model_calls, regenerations from coach_summary where user_id = ${ada.id}`;
      expect(row.model_calls).toBe(3);
      expect(row.regenerations).toBe(2);
      expect(await rateCount(ada)).toBe(3);
      expect(outcomes.filter((o) => o === "err:refresh_cap")).toHaveLength(5);
    }, 30_000);

    it("a call whose row changed under it is still counted, up to the cap", async () => {
      await habitWith(ada, "Read", ["2026-11-02"]);
      const fakeData = JSON.stringify({ headline: "h", summary: "s", wins: [], focus: [], nextStep: "n" });
      const fakeStats = JSON.stringify({ week: W45, daysElapsed: 3, isCurrent: true, totals: { habits: 0, habitsOnGoal: 0, doneCheckIns: 0, completionPct: 0 }, habits: [] });
      state.generate.mockImplementation(async (req: never) => {
        // Something else rewrites the row while the call is in flight (the old "skipped" race).
        await sql`insert into coach_summary (user_id, iso_week, data, stats, mode, input_hash, model_calls) values (${ada.id}, ${W45}, ${fakeData}::jsonb, ${fakeStats}::jsonb, 'skipped', ${"b".repeat(64)}, 2) on conflict (user_id, iso_week) do update set input_hash = ${"b".repeat(64)}, model_calls = 2, regenerations = 1`;
        return actualGenerate(req);
      });
      const r = await post(ada);
      expect(r.cached).toBe(true);
      const [row] = await sql`select model_calls, regenerations, mode from coach_summary where user_id = ${ada.id}`;
      expect(row.model_calls).toBe(3);
      expect(row.regenerations).toBe(2);
      expect(row.mode).toBe("skipped");
      // Counting stops at the cap.
      await sql`update coach_summary set model_calls = 3, regenerations = 2`;
      state.generate.mockImplementation(actualGenerate);
      await expect(post(ada)).rejects.toMatchObject({ reason: "refresh_cap" });
    });

    it("if storing the answer fails, the claim is deleted and both caps are refunded", async () => {
      await habitWith(ada, "Read", ["2026-11-02"]);
      state.generate.mockImplementation(async (req: never) => {
        await sql`alter table coach_summary add constraint coach_tmp_fail check (false) not valid`;
        return actualGenerate(req);
      });
      try {
        await expect(post(ada)).rejects.toMatchObject({ status: 500 });
      } finally {
        await sql`alter table coach_summary drop constraint if exists coach_tmp_fail`;
      }
      expect(Number((await sql`select count(*) n from coach_claim`)[0].n)).toBe(0);
      expect(await rateCount(ada)).toBe(0);
      expect(await dailyCoach()).toBe(0);
    });

    it("a call that outlives its claim does not overwrite the answer that took over", async () => {
      const h = await habitWith(ada, "Read", ["2026-11-02"]);
      // A second module instance, so the in-process dedupe doesn't hand the inner request this very run.
      vi.resetModules();
      const other = await import("@/lib/coach");
      let first = true;
      state.generate.mockImplementation(async (req: never) => {
        if (first) {
          first = false;
          // While this (slow) call runs, its claim goes stale and a second request completes the week.
          await sql`update coach_claim set claimed_at = now() - interval '60 seconds' where user_id = ${ada.id}`;
          await other.generateCoach(ada, null, NOW);
        }
        return actualGenerate(req);
      });
      const slow = await post(ada);
      expect(state.generate).toHaveBeenCalledTimes(2);
      expect(slow.cached).toBe(true); // its own answer was dropped; the stored one is returned
      // Its answer was dropped but paid for: the week counts both calls.
      const [row] = await sql`select model_calls from coach_summary where user_id = ${ada.id}`;
      expect(row.model_calls).toBe(2);
      expect(h.id).toBeDefined();
    });
  });

  it("stores a rejected model answer as the deterministic fallback", async () => {
    await habitWith(ada, "Read", ["2026-11-02", "2026-11-03"]);
    process.env.AI_PROVIDER = "gemini";
    process.env.GEMINI_API_KEY = "test-key";
    envMod.resetEnvCache();
    state.generate.mockImplementation(async (req: { schema: { parse: (v: unknown) => unknown } }) => ({
      data: req.schema.parse({ headline: "Fine", summary: "Ask your doctor about the dosage.", wins: [], focus: [], nextStep: "x" }),
      provider: "gemini", model: "m", demo: false, latencyMs: 3,
    }));
    const r = await post(ada);
    delete process.env.GEMINI_API_KEY;
    expect(r.summary?.mode).toBe("fallback");
    expect(JSON.stringify(r.summary?.data)).not.toMatch(/doctor|dosage/i);
    expect(logged.join("\n")).toContain('"guardrails":["medical_language"]');
  });

  describe("logs", () => {
    it("never carry habit names, values or summary text, on any path", async () => {
      const h = await habitWith(ada, SECRET, [], { kind: "numeric", unit: "pages", dailyTarget: "12345" });
      for (const d of ["2026-11-02", "2026-11-03"]) await checkins.setCheckIn(ada, h.id, d, { value: "12345" }, NOW);
      await checkins.setCheckIn(ada, h.id, "2026-11-04", { value: "98765" }, NOW);
      logged.length = 0;
      await post(ada); // generated
      await post(ada); // cached
      await coach.getCoach(ada, null, NOW);
      await post(ada, "2020-W01").catch(() => undefined); // 400

      // A write that fails in the database: Drizzle's message would hold the query parameters, summary text included.
      state.generate.mockImplementation(async (req: { schema: { parse: (v: unknown) => unknown } }) => ({
        data: req.schema.parse({ headline: "Nice work", summary: `You did ${SECRET} on 3 days.`, wins: [], focus: [], nextStep: "Keep going." }),
        provider: "demo", model: "recorded", demo: false, latencyMs: 1,
      }));
      await sql`delete from coach_summary`;
      await sql`alter table coach_summary add constraint coach_tmp_fail check (false) not valid`;
      state.user = ada;
      try {
        const res = await route.POST(new Request("http://localhost:3000/api/coach", { method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: "{}" }));
        // The route uses the real clock: the week may have no check-ins; only the logs matter below if it did reach the write.
        expect([200, 500]).toContain(res.status);
      } finally {
        await sql`alter table coach_summary drop constraint coach_tmp_fail`;
      }
      const direct = await post(ada).catch((e) => e);
      // Same failure through the data function, with the constraint back in place for just that call.
      await sql`delete from coach_summary`;
      await sql`alter table coach_summary add constraint coach_tmp_fail check (false) not valid`;
      const failed = await post(ada).catch((e) => e);
      await sql`alter table coach_summary drop constraint coach_tmp_fail`;
      expect(direct).toBeDefined();
      expect(failed).toMatchObject({ status: 500, message: expect.stringMatching(/couldn't build your summary/) });
      expect(String(failed.message)).not.toContain(SECRET);

      const out = logged.join("\n");
      expect(out).toContain("coach.failed");
      expect(out).toContain('"pgCode":"23514"');
      for (const secret of [SECRET, "pages", "12345", "98765", "Nice work", "Keep going"]) expect(out).not.toContain(secret);
      expect(out).toContain('"task":"weekly-coach"');
    });
  });
});
