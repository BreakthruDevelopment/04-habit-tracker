/**
 * The demo workspace: CLI refusal rules, the loader against a real Postgres (TEST_DATABASE_URL) and Better Auth,
 * and POST /api/admin/demo. Proves a reload replaces exactly the demo users' rows, real users' rows survive, and
 * the stored coach summaries agree with what `coach.ts` would compute.
 */
import { spawnSync } from "node:child_process";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "@/lib/auth/rbac";
import { demoSeedConfig } from "@/lib/demo-seed-config";

const current = vi.hoisted(() => ({ actor: { id: "ds-admin", role: "admin" as "admin" | "user", name: "Admin", email: "ds-admin@test.local" } }));
vi.mock("@/lib/auth/session", () => ({
  requireRole: vi.fn(async () => {
    if (current.actor.role !== "admin") throw new ForbiddenError();
    return current.actor;
  }),
}));

const base = { DEMO_SEED: "yes", APP_URL: "http://localhost:3000", DEMO_PASSWORD: "demo-test-password-123" };
const tsxArgs = ["--conditions=react-server", "--import", "tsx", "scripts/seed-demo.mts"];

describe("demo CLI guards", () => {
  it.each([undefined, "no", "true"])("refuses DEMO_SEED=%s", (value) => {
    expect(() => demoSeedConfig({ ...base, DEMO_SEED: value })).toThrow("DEMO_SEED=yes");
  });
  it.each(["https://app4.breakthruventures.ai", "http://1-2-3-4.sslip.io"])("refuses production URL %s", (APP_URL) => {
    expect(() => demoSeedConfig({ ...base, APP_URL })).toThrow("production host");
  });
  it.each([
    { ...base, DEMO_SEED: "no" },
    { ...base, APP_URL: "https://app4.breakthruventures.ai" },
    { ...base, APP_URL: "http://1-2-3-4.sslip.io" },
  ])("the actual CLI exits before connecting to a database (%j)", (values) => {
    const child = spawnSync(process.execPath, tsxArgs, {
      env: { ...process.env, ...values, DATABASE_URL: "postgres://invalid:invalid@127.0.0.1:1/invalid" },
      encoding: "utf8",
      timeout: 15000,
    });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("Demo seed refused");
    expect(child.stderr).not.toContain("ECONNREFUSED");
  });
  it("the actual CLI refuses the compose database host and a Cloud SQL socket", () => {
    for (const DATABASE_URL of ["postgres://postgres:x@postgres:5432/habit", "postgres://u:p@/db?host=/cloudsql/proj:r:i"]) {
      const child = spawnSync(process.execPath, tsxArgs, { env: { ...process.env, ...base, DATABASE_URL }, encoding: "utf8", timeout: 15000 });
      expect(child.status).toBe(1);
      expect(child.stderr).toContain("production database");
    }
  });
});

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("demo workspace (Postgres, Better Auth)", () => {
  let sql: postgres.Sql;
  let loader: typeof import("@/lib/demo-workspace");
  let api: ReturnType<typeof import("@/lib/auth").auth>;
  let post: typeof import("@/app/api/admin/demo/route").POST;
  const actor = { id: "ds-admin", role: "admin" as const };
  const real = { id: "ds-real", role: "user" as const };
  const demoEmails = ["ada", "ben", "cleo"].map((n) => `${n}@demo.breakthru.test`);
  const NOW = new Date("2026-11-08T12:00:00Z"); // Sunday, ISO week 2026-W45
  const req = (origin = "http://localhost:3000") => new Request("http://localhost:3000/api/admin/demo", { method: "POST", headers: { origin } });

  async function clean() {
    await sql`delete from "user" where email in ${sql(demoEmails)} or email like 'ds-signup-%'`;
    await sql`delete from habit where owner_id in ('ds-real', 'ds-admin')`;
    await sql`delete from rate_event where user_id like 'ds-%' or kind = 'demo_load'`;
    await sql`delete from daily_usage`;
  }
  beforeAll(async () => {
    Object.assign(process.env, base, {
      NODE_ENV: "test",
      DATABASE_URL: url,
      BETTER_AUTH_SECRET: "demo-integration-secret-32-characters",
      AI_PROVIDER: "demo",
      LOG_LEVEL: "error",
    });
    (await import("@/lib/env")).resetEnvCache();
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    await sql`delete from "user" where id in ('ds-admin', 'ds-real')`;
    for (const p of [actor, real]) {
      await sql`insert into "user" (id, name, email, role) values (${p.id}, ${p.id}, ${p.id + "@test.local"}, ${p.role})`;
    }
    loader = await import("@/lib/demo-workspace");
    api = (await import("@/lib/auth")).auth();
    post = (await import("@/app/api/admin/demo/route")).POST;
  });
  beforeEach(async () => {
    await clean();
    current.actor.role = "admin";
  });
  afterAll(async () => {
    await clean();
    await sql`delete from "user" where id in ('ds-admin', 'ds-real')`;
    await sql.end();
  });

  const load = (mode: "cli" | "admin" = "cli") => loader.loadDemoWorkspace(actor, { mode }, NOW);
  /** An admin-mode load that also reserves the day's slot, as the route does. */
  const loadReserved = (who: { id: string; role: "admin" | "user" } = actor) =>
    loader.loadDemoWorkspace(who, { mode: "admin" }, NOW, { reserve: true });
  const demoIds = async () => (await sql`select id from "user" where email in ${sql(demoEmails)} order by email`).map((r) => r.id as string);

  async function snapshot() {
    const habits = await sql`select u.email, h.name, h.kind, h.unit, h.daily_target::text, h.weekly_goal, h.position
      from habit h join "user" u on u.id = h.owner_id where u.email in ${sql(demoEmails)} order by u.email, h.position`;
    const checkIns = await sql`select u.email, h.name, c.local_date::text, c.value::text, c.done
      from check_in c join habit h on h.id = c.habit_id join "user" u on u.id = c.owner_id where u.email in ${sql(demoEmails)}
      order by u.email, h.position, c.local_date`;
    const coach = await sql`select u.email, s.iso_week, s.data, s.stats, s.mode, s.input_hash, s.model_calls, s.regenerations
      from coach_summary s join "user" u on u.id = s.user_id where u.email in ${sql(demoEmails)} order by u.email`;
    const settings = await sql`select u.email, s.time_zone, s.reminder_time from user_settings s join "user" u on u.id = s.user_id where u.email in ${sql(demoEmails)} order by u.email`;
    // Habit ids are random per load, so they're dropped from the stored stats before comparing.
    const stable = coach.map((r): postgres.Row => ({
      ...r,
      stats: { ...r.stats, habits: (r.stats.habits as Record<string, unknown>[]).map((h) => Object.fromEntries(Object.entries(h).filter(([k]) => k !== "habitId"))) },
    }));
    return { habits, checkIns, coach: stable, settings };
  }

  it("loads 3 users with 4 to 5 mixed habits each, about 60 days of check-ins and a coach summary each", async () => {
    const out = await load();
    expect(out).toMatchObject({ users: 3, habits: 14, coachSummaries: 3 });
    const s = await snapshot();
    expect(s.habits).toHaveLength(14);
    for (const email of demoEmails) {
      const mine = s.habits.filter((h) => h.email === email);
      expect(mine.length).toBeGreaterThanOrEqual(4);
      expect(new Set(mine.map((h) => h.kind))).toEqual(new Set(["check", "numeric"]));
    }
    expect(s.checkIns).toHaveLength(out.checkIns);
    expect(out.checkIns).toBeGreaterThan(400);
    // Numeric habits have partial days (not done) and done days at or above target; check habits store 1.
    const byHabit = new Map(s.habits.map((h) => [`${h.email}|${h.name}`, h]));
    for (const c of s.checkIns) {
      const h = byHabit.get(`${c.email}|${c.name}`)!;
      if (h.kind === "check") expect([Number(c.value), c.done]).toEqual([1, true]);
      else expect(c.done).toBe(Number(c.value) >= Number(h.daily_target));
    }
    expect(s.checkIns.some((c) => c.done === false)).toBe(true);
    expect(s.settings.map((x) => [x.time_zone, x.reminder_time])).toEqual([
      ["America/Denver", null],
      ["Europe/London", null],
      ["Asia/Kolkata", null],
    ]);
    // Dates run from 59 days back to today in each user's own zone.
    const dates = s.checkIns.map((c) => c.local_date).sort();
    expect(dates[0] >= "2026-09-10").toBe(true);
    expect(dates[dates.length - 1] <= "2026-11-09").toBe(true);
  }, 60000);

  it("a second load gives identical data and the same user ids, and a reload keeps real users' rows", async () => {
    const [h] = await sql`insert into habit (owner_id, name) values (${real.id}, 'Real habit') returning id`;
    await sql`insert into check_in (habit_id, owner_id, local_date) values (${h.id}, ${real.id}, '2026-11-01')`;
    await sql`insert into user_settings (user_id, time_zone) values (${real.id}, 'UTC') on conflict do nothing`;
    await sql`insert into coach_summary (user_id, iso_week, data, stats, mode, input_hash) values (${real.id}, '2026-W44', '{}', '{}', 'demo', ${"a".repeat(64)})`;
    await load();
    const first = await snapshot();
    const ids = await demoIds();
    // Extra data a demo user added in between is replaced too.
    await sql`insert into habit (owner_id, name) values (${ids[0]}, 'Added later')`;
    await load("admin");
    expect(await snapshot()).toEqual(first);
    expect(await demoIds()).toEqual(ids);
    expect(await sql`select name from habit where owner_id = ${real.id}`).toEqual([{ name: "Real habit" }]);
    expect(await sql`select 1 from check_in where owner_id = ${real.id}`).toHaveLength(1);
    expect(await sql`select 1 from coach_summary where user_id = ${real.id}`).toHaveLength(1);
    expect(await sql`select 1 from user_settings where user_id = ${real.id}`).toHaveLength(1);
    await sql`delete from user_settings where user_id = ${real.id}`;
  }, 90000);

  it("gives streaks and a heatmap: a long day streak, a broken one, and a 30-day window with activity", async () => {
    await load();
    const { streaks, heatmap } = await import("@/lib/progress");
    const [{ id: adaId }] = await sql`select id from "user" where email = 'ada@demo.breakthru.test'`;
    const ada = { id: adaId as string, role: "user" as const };
    const st = await streaks(ada, NOW);
    const [{ id: stretch }] = await sql`select id from habit where owner_id = ${adaId} and name = 'Stretch'`;
    expect(st[stretch]).toMatchObject({ mode: "day" });
    expect(st[stretch].current).toBeGreaterThanOrEqual(26);
    expect(st[stretch].best).toBeGreaterThanOrEqual(st[stretch].current);
    const [{ id: meditate }] = await sql`select h.id from habit h join "user" u on u.id = h.owner_id where u.email = 'ben@demo.breakthru.test' and h.name = 'Meditate'`;
    const ben = { id: (await sql`select id from "user" where email = 'ben@demo.breakthru.test'`)[0].id as string, role: "user" as const };
    expect((await streaks(ben, NOW))[meditate].best).toBeGreaterThan(0);
    const map = await heatmap(ada, {}, NOW);
    expect(map.days).toHaveLength(30);
    expect(map.days.filter((d) => d.intensity > 0).length).toBeGreaterThan(20);
    // Something is left open today for the first habit of each user.
    const { today } = await import("@/lib/progress");
    const view = await today(ada, NOW);
    expect(view.habits.length).toBe(5);
  }, 60000);

  it("stores last week's summary as mode demo with the hash and counts coach.ts would use, and no push devices", async () => {
    await load();
    const s = await snapshot();
    expect(s.coach).toHaveLength(3);
    for (const row of s.coach) {
      expect(row).toMatchObject({ iso_week: "2026-W44", mode: "demo", model_calls: 0, regenerations: 0 });
      expect(row.input_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.data.summary).toMatch(/^Demo summary/);
    }
    expect(await sql`select 1 from push_subscription where user_id in ${sql(await demoIds())}`).toHaveLength(0);

    const coach = await import("@/lib/coach");
    const [{ id }] = await sql`select id from "user" where email = 'ben@demo.breakthru.test'`;
    const ben = { id: id as string, role: "user" as const };
    const got = await coach.getCoach(ben, "2026-W44", NOW);
    expect(got.summary).toMatchObject({ mode: "demo" });
    expect(got.summary!.stats.habits.length).toBe(4);
    expect(got.refreshesLeft).toBe(2);
    // Under the demo provider the stored hash is current: a refresh returns it and spends nothing.
    const again = await coach.generateCoach(ben, "2026-W44", NOW);
    expect(again.cached).toBe(true);
    expect(await sql`select 1 from rate_event where user_id = ${id} and kind = 'coach'`).toHaveLength(0);
    expect(await sql`select count from daily_usage where kind = 'coach'`).toHaveLength(0);
  }, 60000);

  it("a stale hash behaves sensibly: the refresh regenerates once and counts one call", async () => {
    await load();
    const coach = await import("@/lib/coach");
    const [{ id }] = await sql`select id from "user" where email = 'cleo@demo.breakthru.test'`;
    const cleo = { id: id as string, role: "user" as const };
    await sql`update coach_summary set input_hash = ${"0".repeat(64)} where user_id = ${id}`;
    const out = await coach.generateCoach(cleo, "2026-W44", NOW);
    expect(out.cached).toBe(false);
    expect((await sql`select model_calls from coach_summary where user_id = ${id}`)[0].model_calls).toBe(1);
  }, 60000);

  it("CLI mode gives Ada admin and a known password; the CLI runs end to end", async () => {
    const child = spawnSync(process.execPath, tsxArgs, { env: { ...process.env, ...base, DATABASE_URL: url }, encoding: "utf8", timeout: 40000 });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toMatch(/Loaded 3 demo users, 14 habits, \d+ check-ins and 3 coach summaries\./);
    expect((await sql`select role from "user" where email = 'ada@demo.breakthru.test'`)[0].role).toBe("admin");
    expect((await api.api.signInEmail({ body: { email: "ben@demo.breakthru.test", password: base.DEMO_PASSWORD } })).user.id).toBeTruthy();
  }, 60000);

  it("admin mode creates unprivileged users with unknown, distinct passwords and ends their sessions on reload", async () => {
    await load("admin");
    expect((await sql`select role from "user" where email in ${sql(demoEmails)}`).every((u) => u.role === "user")).toBe(true);
    const hashes = await sql`select a.password from account a join "user" u on u.id = a.user_id where u.email in ${sql(demoEmails)}`;
    expect(new Set(hashes.map((h) => h.password)).size).toBe(3);
    await load("cli");
    const signed = await api.api.signInEmail({ body: { email: "ada@demo.breakthru.test", password: base.DEMO_PASSWORD } });
    await load("admin");
    expect(await sql`select 1 from session where token = ${signed.token}`).toHaveLength(0);
    await expect(api.api.signInEmail({ body: { email: "ada@demo.breakthru.test", password: base.DEMO_PASSWORD } })).rejects.toBeDefined();
    expect((await sql`select role from "user" where email in ${sql(demoEmails)}`).every((u) => u.role === "user")).toBe(true);
  }, 90000);

  it("removes push subscriptions a demo user somehow has, and leaves real users' devices alone", async () => {
    await load();
    const [ada] = await demoIds();
    const sub = (u: string, n: string) => sql`insert into push_subscription (user_id, endpoint, p256dh, auth, device_label, vapid_key_id) values (${u}, ${"https://fcm.googleapis.com/fcm/send/" + n}, ${"p".repeat(87)}, ${"a".repeat(22)}, 'x', 'abcd1234')`;
    await sub(ada, "demo");
    await sub(real.id, "real");
    await load();
    expect(await sql`select 1 from push_subscription where user_id = ${ada}`).toHaveLength(0);
    expect(await sql`select 1 from push_subscription where user_id = ${real.id}`).toHaveLength(1);
    await sql`delete from push_subscription where user_id = ${real.id}`;
  }, 60000);

  it("the loader refuses non-admins and unknown options", async () => {
    await expect(loader.loadDemoWorkspace(real)).rejects.toMatchObject({ status: 403 });
    await expect(loader.loadDemoWorkspace(actor, { mode: "cli", password: "override" })).rejects.toMatchObject({ name: "ZodError" });
    await expect(loadReserved(real)).rejects.toMatchObject({ status: 403 });
    expect((await snapshot()).habits).toHaveLength(0);
  });

  it("route: admin loads and gets counts only; the second call in a minute is 429", async () => {
    const first = await post(req());
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(Object.keys(body).sort()).toEqual(["checkIns", "coachSummaries", "habits", "users"]);
    expect(body).toMatchObject({ users: 3, habits: 14, coachSummaries: 3 });
    const second = await post(req());
    expect(second.status).toBe(429);
    expect((await second.json()).error).toMatch(/once per minute/);
    expect((await snapshot()).habits).toHaveLength(14);
  }, 60000);

  it("route rejects non-admins and foreign or missing Origin before reserving a load or changing anything", async () => {
    current.actor.role = "user";
    expect((await post(req())).status).toBe(403);
    current.actor.role = "admin";
    expect((await post(req("https://other.breakthruventures.ai"))).status).toBe(403);
    expect((await post(new Request("http://localhost:3000/api/admin/demo", { method: "POST" }))).status).toBe(403);
    expect(await sql`select 1 from rate_event where kind = 'demo_load'`).toHaveLength(0);
    expect(await sql`select 1 from daily_usage where kind = 'demo_load'`).toHaveLength(0);
    expect((await snapshot()).habits).toHaveLength(0);
  });

  it("allows 5 loads per UTC day app-wide, then refuses without changing data", async () => {
    for (let i = 0; i < 5; i++) {
      await loadReserved();
      await sql`delete from rate_event where kind = 'demo_load'`; // skip the minute wait
    }
    const before = await snapshot();
    await expect(loadReserved()).rejects.toMatchObject({ status: 429 });
    expect((await sql`select count from daily_usage where kind = 'demo_load'`)[0].count).toBe(5);
    expect((await post(req())).status).toBe(429);
    expect(await sql`select 1 from rate_event where kind = 'demo_load'`).toHaveLength(0);
    expect(await snapshot()).toEqual(before);
  }, 120000);

  it("reserves one load under concurrency and expires the minute window", async () => {
    const results = await Promise.allSettled([loadReserved(), loadReserved()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ status: 429 });
    await expect(loadReserved()).rejects.toMatchObject({ status: 429, message: expect.stringMatching(/once per minute/) });
    await sql`update rate_event set at = now() - interval '61 seconds' where kind = 'demo_load'`;
    await loadReserved();
  }, 90000);

  it("regression: five parallel POSTs, round after round, give exactly one 200 (the lock winner is never refused)", async () => {
    for (let round = 0; round < 3; round++) {
      await sql`delete from rate_event where kind = 'demo_load'`;
      await sql`delete from daily_usage`;
      const res = await Promise.all(Array.from({ length: 5 }, () => post(req())));
      const codes = res.map((r) => r.status).sort();
      expect(codes, `round ${round}`).toEqual([200, 429, 429, 429, 429]);
      expect((await sql`select count from daily_usage where kind = 'demo_load'`)[0].count).toBe(1);
      expect(await sql`select 1 from rate_event where kind = 'demo_load'`).toHaveLength(1);
    }
    expect((await snapshot()).habits).toHaveLength(14);
  }, 120000);

  it("reservations and a second load while a load holds the lock answer 429 'already running' at once instead of exhausting the pool", async () => {
    // Hold the load lock from the test's own connection, so the outcome doesn't depend on how fast a real load runs.
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended('demo-load', 0))`;
      const started = Date.now();
      const calls = await Promise.race([
        Promise.allSettled([...Array.from({ length: 4 }, () => loadReserved()), load()]),
        new Promise<"hung">((r) => setTimeout(() => r("hung"), 8000)),
      ]);
      expect(calls).not.toBe("hung");
      expect(Date.now() - started).toBeLessThan(5000);
      for (const c of calls as PromiseSettledResult<unknown>[]) {
        expect(c.status).toBe("rejected");
        expect((c as PromiseRejectedResult).reason).toMatchObject({ status: 429, message: expect.stringMatching(/already running/) });
      }
    });
    // Nothing was reserved or loaded, and once the lock is free a load goes through.
    expect(await sql`select 1 from rate_event where kind = 'demo_load'`).toHaveLength(0);
    expect(await loadReserved()).toMatchObject({ users: 3, habits: 14 });
  }, 60000);

  it("a failed route load gives back the day's reservation", async () => {
    const collision = await api.api.createUser({ body: { email: "ada@demo.breakthru.test", name: "Real Ada", password: base.DEMO_PASSWORD } });
    expect(collision.user.id).toBeTruthy();
    expect((await post(req())).status).toBe(409);
    // The reservation lives in the load's transaction, so a failed load leaves no trace at all.
    expect(await sql`select 1 from daily_usage where kind = 'demo_load' and count > 0`).toHaveLength(0);
    expect(await sql`select 1 from rate_event where kind = 'demo_load'`).toHaveLength(0);
    expect((await post(req())).status).toBe(409); // not 429: the minute window wasn't burned either
  }, 30000);

  it("refuses to adopt an unrelated account at a demo address, and nothing is replaced", async () => {
    const collision = await api.api.createUser({ body: { email: "ada@demo.breakthru.test", name: "Real Ada", password: base.DEMO_PASSWORD } });
    await sql`insert into habit (owner_id, name) values (${collision.user.id}, 'Keep me')`;
    await expect(loader.loadDemoWorkspace(actor, { mode: "admin" }, NOW)).rejects.toMatchObject({ status: 409 });
    expect(await sql`select name from habit where owner_id = ${collision.user.id}`).toEqual([{ name: "Keep me" }]);
    expect(await sql`select 1 from "user" where email in ('ben@demo.breakthru.test', 'cleo@demo.breakthru.test')`).toHaveLength(0);
  }, 30000);

  it("refuses to load from a demo account itself", async () => {
    await load();
    const [id] = await demoIds();
    await expect(loader.loadDemoWorkspace({ id, role: "admin" }, { mode: "admin" }, NOW)).rejects.toMatchObject({ status: 409 });
  }, 60000);

  it("public sign-up cannot claim a demo email or the marker, and the loader still works", async () => {
    const signUp = (payload: Record<string, unknown>) =>
      api.handler(new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { origin: "http://localhost:3000", "content-type": "application/json" },
        body: JSON.stringify({ name: "Mallory", password: base.DEMO_PASSWORD, ...payload }),
      }));
    expect((await signUp({ email: "mallory@demo.breakthru.test" })).status).toBe(400);
    expect((await signUp({ email: "ds-signup-marker@test.local", image: "urn:breakthru:habit-demo:v1" })).status).toBe(400);
    expect(await load()).toMatchObject({ users: 3 });
  }, 60000);

  it("a stale demo-user rate ledger is cleared on reload", async () => {
    await load();
    const [{ id: adaId }] = await sql`select id from "user" where email = 'ada@demo.breakthru.test'`;
    for (const kind of ["checkin", "habit_write", "coach"]) await sql`insert into rate_event (user_id, kind) values (${adaId}, ${kind})`;
    await load();
    expect(await sql`select 1 from rate_event where user_id = ${adaId}`).toHaveLength(0);
  }, 60000);

  it("uses each user's own time zone for the latest day and the summary week", async () => {
    const LATE = new Date("2026-11-09T03:00:00Z"); // Sun evening in Denver, Mon morning in London and Kolkata
    await loader.loadDemoWorkspace(actor, { mode: "cli" }, LATE);
    const latest = await sql`select u.email, max(c.local_date)::text as latest from check_in c join "user" u on u.id = c.owner_id
      where u.email in ${sql(demoEmails)} group by u.email order by u.email`;
    expect(latest.map((r) => r.latest)).toEqual(["2026-11-08", "2026-11-09", "2026-11-09"]);
    const weeks = await sql`select u.email, s.iso_week from coach_summary s join "user" u on u.id = s.user_id where u.email in ${sql(demoEmails)} order by u.email`;
    expect(weeks.map((r) => r.iso_week)).toEqual(["2026-W44", "2026-W45", "2026-W45"]);
  }, 60000);

  it("a failing coach seed for one user is logged without a message and lowers the count instead of throwing", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const prev = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "error";
    try {
      const { db } = await import("@/lib/db");
      const real = db().insert.bind(db());
      let calls = 0;
      vi.spyOn(db(), "insert").mockImplementation(((table: unknown) => {
        const name = (table as { [k: symbol]: unknown })?.[Symbol.for("drizzle:Name")];
        if (name === "coach_summary" && ++calls === 2) throw new Error("boom with secret-param-xyz");
        return real(table as never);
      }) as never);
      const out = await load();
      expect(out).toMatchObject({ users: 3, habits: 14, coachSummaries: 2 });
      const lines = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("demo.coach_seed_failed"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toMatch(/boom|secret-param/);
      expect((await snapshot()).habits).toHaveLength(14);
    } finally {
      vi.restoreAllMocks();
      process.env.LOG_LEVEL = prev;
    }
  }, 60000);

  describe("auth hooks keep demo identities off every request-driven path", () => {
    const origin = { origin: "http://localhost:3000", "content-type": "application/json" };
    const call = (path: string, body: unknown, cookie = "") =>
      api.handler(new Request(`http://localhost:3000/api/auth/${path}`, { method: "POST", headers: { ...origin, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }));
    const cookieOf = (r: Response) => r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const MARK = "urn:breakthru:habit-demo:v1";

    it("update-user cannot set the marker or a demo email on a normal account", async () => {
      const ok = await call("sign-up/email", { name: "Pat", email: "ds-signup-pat@test.local", password: base.DEMO_PASSWORD });
      expect(ok.status).toBe(200);
      const cookie = cookieOf(ok);
      expect((await call("update-user", { image: MARK }, cookie)).status).toBe(400);
      expect((await sql`select image from "user" where email = 'ds-signup-pat@test.local'`)[0].image).toBeNull();
    });

    it("an admin cannot create or update a user into a demo identity either", async () => {
      const signed = await call("sign-up/email", { name: "Root", email: "ds-signup-root@test.local", password: base.DEMO_PASSWORD });
      await sql`update "user" set role = 'admin' where email = 'ds-signup-root@test.local'`;
      const cookie = cookieOf(signed);
      const before = Number((await sql`select count(*) n from "user"`)[0].n);

      for (const body of [{ email: "mallory@demo.breakthru.test", name: "M", password: base.DEMO_PASSWORD, role: "user" }, { email: "ds-signup-m@test.local", name: "M", password: base.DEMO_PASSWORD, role: "user", data: { image: MARK } }]) {
        const res = await call("admin/create-user", body, cookie);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      expect(Number((await sql`select count(*) n from "user"`)[0].n)).toBe(before);

      const [victim] = await sql`insert into "user" (id, name, email, role) values ('ds-signup-victim', 'V', 'ds-signup-victim@test.local', 'user') returning id`;
      for (const data of [{ image: MARK }, { email: "ben@demo.breakthru.test" }]) {
        const res = await call("admin/update-user", { userId: victim.id, data }, cookie);
        // The marker is refused by the hook (400); changing an email is already refused by the role (no set-email, 403).
        expect([400, 403], JSON.stringify(data)).toContain(res.status);
      }
      expect(await sql`select image, email from "user" where id = ${victim.id}`).toEqual([{ image: null, email: "ds-signup-victim@test.local" }]);
      await sql`delete from "user" where id = 'ds-signup-victim'`;
    });
  });
});
