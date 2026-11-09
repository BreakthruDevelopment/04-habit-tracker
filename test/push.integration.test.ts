/**
 * Web push against a real Postgres (TEST_DATABASE_URL), with `web-push`'s send stubbed: nothing here ever reaches a
 * real push service. Covers the subscription rules (SSRF allow-list, reassignment, 5-device cap), send-result
 * handling, the reminder run (once per local day, windows, DST, zone changes, caps) and VAPID key creation.
 */
import { createECDH, randomBytes } from "node:crypto";
import { sql as dsql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;

const state = vi.hoisted(() => ({
  user: null as null | { id: string; role: "user" | "admin"; name: string; email: string },
  send: vi.fn(),
  pairs: [] as { publicKey: string; privateKey: string }[],
}));

vi.mock("web-push", async (orig) => {
  const actual = await orig<typeof import("web-push")>();
  return {
    ...actual,
    sendNotification: state.send,
    // Remember every pair generated, so a test can check the private key never shows up anywhere.
    generateVAPIDKeys: () => {
      const pair = actual.generateVAPIDKeys();
      state.pairs.push(pair);
      return pair;
    },
  };
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
const ORIGIN = "http://localhost:3000";
const utc = (iso: string) => new Date(iso);
const FCM = "https://fcm.googleapis.com/fcm/send/";

function webPushKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") };
}
const failWith = (statusCode?: number) => Object.assign(new Error("push failed"), statusCode === undefined ? {} : { statusCode });

describe.skipIf(!url)("web push (Postgres)", () => {
  let sql: postgres.Sql;
  let push: typeof import("@/lib/push");
  let vapid: typeof import("@/lib/vapid");
  let usage: typeof import("@/lib/usage");
  let envMod: typeof import("@/lib/env");
  let dbm: typeof import("@/lib/db");

  const mk = (id: string, role: "user" | "admin" = "user"): U => ({ id: `pu-${id}`, role, name: id, email: `pu-${id}@test.local` });
  const ada = mk("ada");
  const ben = mk("ben");
  const cat = mk("cat");
  const root = mk("root", "admin");
  const all = [ada, ben, cat, root];

  const json = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
    new Request("http://localhost:3000/x", {
      method,
      headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function clean() {
    await sql`delete from habit where owner_id like 'pu-%'`;
    await sql`delete from push_subscription where user_id like 'pu-%'`;
    await sql`delete from user_settings where user_id like 'pu-%'`;
    await sql`delete from rate_event where user_id like 'pu-%'`;
    await sql`delete from daily_usage`;
  }

  /** A device row stored under the current VAPID key. */
  async function device(u: U, endpoint = `${FCM}${randomBytes(6).toString("hex")}`) {
    const { keyId } = await vapid.getVapidKeys();
    const k = webPushKeys();
    const [row] = await sql`
      insert into push_subscription (user_id, endpoint, p256dh, auth, vapid_key_id)
      values (${u.id}, ${endpoint}, ${k.p256dh}, ${k.auth}, ${keyId}) returning id, endpoint`;
    return { id: row.id as string, endpoint: row.endpoint as string };
  }

  /** A user with reminders on, one device and one open habit named "Secret Therapy". */
  async function reminded(u: U, tz: string, time: string, opts: { habit?: boolean } = {}) {
    await sql`insert into user_settings (user_id, time_zone, reminder_time) values (${u.id}, ${tz}, ${time}) on conflict (user_id) do update set time_zone = ${tz}, reminder_time = ${time}, last_reminder_on = null, last_reminder_at = null`;
    const d = await device(u);
    let habitId: string | undefined;
    if (opts.habit !== false) {
      [{ id: habitId }] = await sql`insert into habit (owner_id, name) values (${u.id}, 'Secret Therapy') returning id`;
    }
    return { ...d, habitId: habitId as string };
  }

  const sentTo = () => state.send.mock.calls.map((c) => (c[0] as { endpoint: string }).endpoint);
  const claimOn = async (u: U) => (await sql`select last_reminder_on::text d from user_settings where user_id = ${u.id}`)[0]?.d as string | null;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    for (const u of all) {
      await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.name}, ${u.email}, ${u.role}) on conflict do nothing`;
    }
    push = await import("@/lib/push");
    vapid = await import("@/lib/vapid");
    usage = await import("@/lib/usage");
    envMod = await import("@/lib/env");
    dbm = await import("@/lib/db");
  });

  afterAll(async () => {
    await sql`delete from "user" where id like 'pu-%'`;
    await sql.end();
  });

  beforeEach(async () => {
    await clean();
    state.send.mockReset();
    state.send.mockResolvedValue({ statusCode: 201 });
    state.user = null;
  });

  afterEach(() => {
    delete process.env.PUSH_DAILY_CAP;
    envMod.resetEnvCache();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  describe("the reminder run", () => {
    it("sends once per local day across runs, with counts only and the Topic header", async () => {
      const a = await reminded(ada, "America/Denver", "20:00");
      const first = utc("2026-11-09T03:30:00Z"); // 20:30 MST on 2026-11-08
      expect(await push.runReminders(first)).toEqual({ considered: 1, claimed: 1, sent: 1, removed: 0, failed: 0 });
      expect(await push.runReminders(utc("2026-11-09T04:30:00Z"))).toMatchObject({ considered: 0, claimed: 0, sent: 0 });
      expect(sentTo()).toEqual([a.endpoint]);
      expect(await claimOn(ada)).toBe("2026-11-08");

      const [, body, options] = state.send.mock.calls[0];
      expect(JSON.parse(body as string)).toEqual({ title: "Habits", body: "1 habit left today", url: "/today", tag: "daily-reminder" });
      expect(body as string).not.toMatch(/Secret|Therapy/);
      expect(Buffer.byteLength(body as string)).toBeLessThan(1024);
      expect(options).toMatchObject({ TTL: 4 * 3600, urgency: "normal", topic: "daily-reminder", timeout: 10_000 });

      // The next local day (24 h later) reminds again.
      expect(await push.runReminders(utc("2026-11-10T03:30:00Z"))).toMatchObject({ claimed: 1, sent: 1 });
      expect(state.send).toHaveBeenCalledTimes(2);
    });

    it("is silent when everything is done, or the weekly goal is already met, but still uses up the day", async () => {
      const a = await reminded(ada, "America/Denver", "20:00", { habit: false });
      await sql`insert into habit (owner_id, name) values (${ada.id}, 'Done today') returning id`;
      const [h] = await sql`select id from habit where owner_id = ${ada.id}`;
      await sql`insert into check_in (habit_id, owner_id, local_date) values (${h.id}, ${ada.id}, '2026-11-08')`;
      // Weekly goal of 2 already met by Monday and Tuesday (ISO week 2026-W45 is Nov 2 to Nov 8).
      const b = await reminded(ben, "America/Denver", "20:00", { habit: false });
      const [g] = await sql`insert into habit (owner_id, name, weekly_goal) values (${ben.id}, 'Goal met', 2) returning id`;
      for (const d of ["2026-11-02", "2026-11-03"]) await sql`insert into check_in (habit_id, owner_id, local_date) values (${g.id}, ${ben.id}, ${d})`;

      expect(await push.runReminders(utc("2026-11-09T03:30:00Z"))).toEqual({ considered: 2, claimed: 2, sent: 0, removed: 0, failed: 0 });
      expect(state.send).not.toHaveBeenCalled();
      expect([a.id, b.id].length).toBe(2);
      expect(await claimOn(ada)).toBe("2026-11-08");
    });

    it("fires on time for Denver and Kolkata in the same run, and for nobody who isn't due", async () => {
      const den = await reminded(ada, "America/Denver", "08:00");
      const kol = await reminded(ben, "Asia/Kolkata", "20:30");
      const early = await reminded(cat, "America/Denver", "20:00");
      // 15:10Z is 08:10 in Denver (MST) and 20:40 in Kolkata.
      const res = await push.runReminders(utc("2026-11-08T15:10:00Z"));
      expect(res).toMatchObject({ considered: 2, claimed: 2, sent: 2 });
      expect(sentTo().sort()).toEqual([den.endpoint, kol.endpoint].sort());
      expect(sentTo()).not.toContain(early.endpoint);
      expect(await claimOn(ada)).toBe("2026-11-08");
      expect(await claimOn(ben)).toBe("2026-11-08");
    });

    it("works on both 2026 DST days in Denver (a 23-hour day and a 25-hour day), once each", async () => {
      const u = await reminded(ada, "America/Denver", "05:00");
      // 2026-03-08: clocks jump at 02:00, so 05:00 is MDT (UTC-6), i.e. 11:00Z.
      expect(await push.runReminders(utc("2026-03-08T10:59:59Z"))).toMatchObject({ considered: 0 });
      expect(await push.runReminders(utc("2026-03-08T11:00:00Z"))).toMatchObject({ claimed: 1, sent: 1 });
      expect(await push.runReminders(utc("2026-03-08T12:30:00Z"))).toMatchObject({ considered: 0 });
      // (Seven months on, a device with no success since March would be pruned as stale; keep this one fresh.)
      await sql`update push_subscription set last_success_at = '2026-10-31'`;
      // 2026-11-01: clocks fall back at 02:00, so 05:00 is MST (UTC-7), i.e. 12:00Z.
      state.send.mockClear();
      expect(await push.runReminders(utc("2026-11-01T11:59:59Z"))).toMatchObject({ considered: 0 });
      expect(await push.runReminders(utc("2026-11-01T12:00:00Z"))).toMatchObject({ claimed: 1, sent: 1 });
      expect(await push.runReminders(utc("2026-11-01T14:00:00Z"))).toMatchObject({ considered: 0 });
      expect(sentTo()).toEqual([u.endpoint]);

      // A 21:00 reminder on those days ends at local midnight, which is 06:00Z after the 23-hour day...
      await sql`update user_settings set reminder_time = '21:00', last_reminder_on = null, last_reminder_at = null where user_id = ${ada.id}`;
      expect(await push.runReminders(utc("2026-03-09T05:59:59Z"))).toMatchObject({ considered: 1 }); // 23:59:59 MDT on Mar 8
      await sql`update user_settings set last_reminder_on = null, last_reminder_at = null where user_id = ${ada.id}`;
      expect(await push.runReminders(utc("2026-03-09T06:00:00Z"))).toMatchObject({ considered: 0 }); // 00:00 MDT on Mar 9
      // ...and 07:00Z after the 25-hour day.
      await sql`update push_subscription set last_success_at = '2026-10-31'`;
      await sql`update user_settings set last_reminder_on = null, last_reminder_at = null where user_id = ${ada.id}`;
      expect(await push.runReminders(utc("2026-11-02T06:59:59Z"))).toMatchObject({ considered: 1 });
      await sql`update user_settings set last_reminder_on = null, last_reminder_at = null where user_id = ${ada.id}`;
      expect(await push.runReminders(utc("2026-11-02T07:00:00Z"))).toMatchObject({ considered: 0 });
    });

    it("ends the window at local midnight: a 21:00 reminder is eligible at 23:59 local and not at 00:01", async () => {
      await reminded(ada, "America/Denver", "21:00");
      expect(await push.runReminders(utc("2026-11-09T07:01:00Z"))).toMatchObject({ considered: 0 }); // 00:01 on Nov 9
      expect(await push.runReminders(utc("2026-11-09T06:59:00Z"))).toMatchObject({ considered: 1, claimed: 1, sent: 1 }); // 23:59 on Nov 8
      // Before midnight the 3 hour window is cut short; an earlier slot (21:00 to 23:59) is the only chance.
      await sql`update user_settings set last_reminder_on = null, last_reminder_at = null where user_id = ${ada.id}`;
      expect(await push.runReminders(utc("2026-11-09T07:00:00Z"))).toMatchObject({ considered: 0 });
    });

    it("doesn't remind again within 12 h after a zone change that repeats the local date (Kiritimati to Pago Pago)", async () => {
      const u = await reminded(ada, "Pacific/Kiritimati", "20:00");
      const t = utc("2026-11-08T06:30:00Z"); // 20:30 on Nov 8 in Kiritimati (UTC+14)
      expect(await push.runReminders(t)).toMatchObject({ claimed: 1, sent: 1 });
      expect(await claimOn(ada)).toBe("2026-11-08");
      // Right after: Pago Pago (UTC-11) is on Nov 7 at 19:30, so the date differs and 19:00 is in its window.
      await sql`update user_settings set time_zone = 'Pacific/Pago_Pago', reminder_time = '19:00' where user_id = ${ada.id}`;
      const soon = utc("2026-11-08T06:31:00Z");
      expect(await push.runReminders(soon)).toMatchObject({ considered: 0, sent: 0 });
      expect(sentTo()).toEqual([u.endpoint]);
      // Control: without the 12 h rule the same state is eligible, so the gap is what held it back.
      await sql`update user_settings set last_reminder_at = null where user_id = ${ada.id}`;
      expect(await push.runReminders(soon)).toMatchObject({ considered: 1, sent: 1 });
    });

    it("doesn't remind again within 12 h after Kolkata to Denver either", async () => {
      await reminded(ben, "Asia/Kolkata", "05:00");
      const t = utc("2026-11-08T23:35:00Z"); // 05:05 on Nov 9 in Kolkata
      expect(await push.runReminders(t)).toMatchObject({ claimed: 1, sent: 1 });
      expect(await claimOn(ben)).toBe("2026-11-09");
      await sql`update user_settings set time_zone = 'America/Denver', reminder_time = '16:30' where user_id = ${ben.id}`; // 16:35 on Nov 8 there
      expect(await push.runReminders(t)).toMatchObject({ considered: 0 });
      await sql`update user_settings set last_reminder_at = null where user_id = ${ben.id}`;
      expect(await push.runReminders(t)).toMatchObject({ considered: 1 });
    });

    it("counts open habits on SQL's local_date, pinned 1 s before local midnight", async () => {
      // Denver, 21:00 reminder, now = 23:59:59 on Nov 8.
      const now = utc("2026-11-09T06:59:59Z");
      // Ada: her only habit is done on Nov 8, so nothing is open.
      const a = await reminded(ada, "America/Denver", "21:00");
      await sql`insert into check_in (habit_id, owner_id, local_date) values (${a.habitId}, ${ada.id}, '2026-11-08')`;
      // Ben: one habit done only on Nov 9 (a row for the day after) and one done on Nov 8: exactly one is open on Nov 8.
      const b = await reminded(ben, "America/Denver", "21:00");
      const [other] = await sql`insert into habit (owner_id, name) values (${ben.id}, 'Other') returning id`;
      await sql`insert into check_in (habit_id, owner_id, local_date) values (${b.habitId}, ${ben.id}, '2026-11-09'), (${other.id}, ${ben.id}, '2026-11-08')`;
      expect(await push.runReminders(now)).toMatchObject({ considered: 2, claimed: 2, sent: 1 });
      expect(sentTo()).toEqual([b.endpoint]);
      expect(JSON.parse(state.send.mock.calls[0][1] as string).body).toBe("1 habit left today");
    });

    it("skips users whose stored zone Postgres doesn't know, without failing the run", async () => {
      await reminded(ada, "Mars/Olympus", "08:00");
      const ok = await reminded(ben, "America/Denver", "08:00");
      expect(await push.runReminders(utc("2026-11-08T15:10:00Z"))).toMatchObject({ considered: 1, sent: 1 });
      expect(sentTo()).toEqual([ok.endpoint]);
    });

    it("doesn't claim a user whose reminder time changed between the read and the claim", async () => {
      await reminded(ada, "America/Denver", "08:00");
      const database = dbm.db();
      const original = database.execute.bind(database);
      let calls = 0;
      vi.spyOn(database, "execute").mockImplementation((async (...args: Parameters<typeof original>) => {
        const result = await original(...args);
        if (++calls === 1) await sql`update user_settings set reminder_time = '20:00' where user_id = ${ada.id}`; // after the eligibility read
        return result;
      }) as never);
      expect(await push.runReminders(utc("2026-11-08T15:10:00Z"))).toMatchObject({ considered: 1, claimed: 0, sent: 0 });
      expect(state.send).not.toHaveBeenCalled();
      expect(await claimOn(ada)).toBeNull();
    });

    it("returns busy while another run holds the lock, and releases it afterwards", async () => {
      await reminded(ada, "America/Denver", "08:00");
      const other = postgres(url!, { max: 1, onnotice: () => {} });
      try {
        await other`select pg_advisory_lock(hashtextextended('reminders:run', 0))`;
        expect(await push.runReminders(utc("2026-11-08T15:10:00Z"))).toEqual({ skipped: "busy" });
        expect(state.send).not.toHaveBeenCalled();
        await other`select pg_advisory_unlock(hashtextextended('reminders:run', 0))`;
      } finally {
        await other.end();
      }
      expect(await push.runReminders(utc("2026-11-08T15:10:00Z"))).toMatchObject({ claimed: 1, sent: 1 });
    });

    it("claims before sending: a crash during the send can't cause a second reminder", async () => {
      await reminded(ada, "America/Denver", "08:00");
      state.send.mockImplementationOnce(async () => {
        // At this moment the claim must already be committed.
        expect(await claimOn(ada)).toBe("2026-11-08");
        throw failWith(500);
      });
      await push.runReminders(utc("2026-11-08T15:10:00Z"));
      expect(await push.runReminders(utc("2026-11-08T15:20:00Z"))).toMatchObject({ considered: 0 });
    });
  });

  // -------------------------------------------------------------------------
  describe("send results", () => {
    const payload = { title: "Habits", body: "1 habit left today", url: "/today", tag: "daily-reminder" };

    it("deletes the row on 404 and 410", async () => {
      for (const code of [404, 410]) {
        const d = await device(ada);
        state.send.mockRejectedValueOnce(failWith(code));
        expect(await push.sendToUser(ada.id, payload)).toEqual({ sent: 0, removed: 1, failed: 0 });
        expect(await sql`select 1 from push_subscription where id = ${d.id}`).toHaveLength(0);
      }
    });

    it("keeps the row on 500 and on a timeout, counting failures, and resets them on success", async () => {
      const d = await device(ada);
      state.send.mockRejectedValueOnce(failWith(500)).mockRejectedValueOnce(failWith());
      await push.sendToUser(ada.id, payload);
      await push.sendToUser(ada.id, payload);
      let [row] = await sql`select failure_count, last_status from push_subscription where id = ${d.id}`;
      expect(row.failure_count).toBe(2);
      expect(row.last_status).toBeNull();
      await push.sendToUser(ada.id, payload);
      [row] = await sql`select failure_count, last_status, last_success_at from push_subscription where id = ${d.id}`;
      expect(row).toMatchObject({ failure_count: 0, last_status: 201 });
      expect(row.last_success_at).not.toBeNull();
    });

    it("deletes a device after 10 failures in a row, and prunes ones with no success in 60 days", async () => {
      const d = await device(ada);
      state.send.mockRejectedValue(failWith(503));
      for (let i = 0; i < 9; i++) await push.sendToUser(ada.id, payload);
      expect(await sql`select 1 from push_subscription where id = ${d.id}`).toHaveLength(1);
      expect(await push.sendToUser(ada.id, payload)).toMatchObject({ removed: 1 });
      const old = await device(ben);
      await sql`update push_subscription set created_at = '2026-01-01' where id = ${old.id}`;
      expect(await push.pruneSubscriptions(utc("2026-11-08T00:00:00Z"))).toBe(1);
    });

    it("keeps the row on 400 and 413, and stops sending to a host that answers 429", async () => {
      const a = await device(ada);
      state.send.mockRejectedValueOnce(failWith(413));
      expect(await push.sendToUser(ada.id, payload)).toMatchObject({ failed: 1, removed: 0 });
      expect((await sql`select failure_count from push_subscription where id = ${a.id}`)[0].failure_count).toBe(0);

      state.send.mockReset();
      state.send.mockRejectedValue(failWith(429));
      await device(ada);
      const ctx = push.newSendContext();
      await push.sendToUser(ada.id, payload, { ctx });
      // One request got the 429 (two are in flight at once for two devices on one host); a later user is skipped.
      state.send.mockClear();
      await device(ben);
      expect(await push.sendToUser(ben.id, payload, { ctx })).toEqual({ sent: 0, removed: 0, failed: 0 });
      expect(state.send).not.toHaveBeenCalled();
    });

    it("stops sending at PUSH_DAILY_CAP", async () => {
      process.env.PUSH_DAILY_CAP = "2";
      envMod.resetEnvCache();
      for (let i = 0; i < 3; i++) await device(ada);
      const res = await push.sendToUser(ada.id, payload);
      expect(res.sent).toBe(2);
      expect(state.send).toHaveBeenCalledTimes(2);
      expect(await usage.dailyCount("push")).toBe(2);
      // And a reminder run claims nobody once the cap is reached.
      await reminded(ben, "America/Denver", "08:00");
      expect(await push.runReminders(utc("2026-11-08T15:10:00Z"))).toMatchObject({ claimed: 0, sent: 0 });
      expect(state.send).toHaveBeenCalledTimes(2);
      // A capped user isn't claimed, so they keep their reminder for when the cap allows it.
      expect(await claimOn(ben)).toBeNull();
    });

    it("never has more than 10 sends in flight, across users", async () => {
      const users = [ada, ben, cat, root, mk("dee"), mk("eve")];
      for (const u of users.slice(4)) await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.name}, ${u.email}, 'user') on conflict do nothing`;
      for (const u of users) for (let i = 0; i < 5; i++) await device(u);
      let active = 0;
      let peak = 0;
      state.send.mockImplementation(async () => {
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, 15));
        active--;
        return { statusCode: 201 };
      });
      const all = await Promise.all(users.map((u) => push.sendToUser(u.id, payload)));
      expect(all.reduce((n, r) => n + r.sent, 0)).toBe(30);
      expect(peak).toBeLessThanOrEqual(10);
      expect(peak).toBeGreaterThan(1);
    });

    it("refuses to call an endpoint that isn't on the allow-list, even if one got into the table", async () => {
      const { keyId } = await vapid.getVapidKeys();
      const k = webPushKeys();
      await sql`insert into push_subscription (user_id, endpoint, p256dh, auth, vapid_key_id) values (${ada.id}, 'https://evil.example/x', ${k.p256dh}, ${k.auth}, ${keyId})`;
      expect(await push.sendToUser(ada.id, payload)).toMatchObject({ removed: 1, sent: 0 });
      expect(state.send).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe("subscriptions", () => {
    const body = (endpoint = `${FCM}abc`) => ({ endpoint, keys: webPushKeys() });

    it("refuses endpoints that aren't https on a known push service", async () => {
      const bad = [
        "https://evil.example/",
        "http://fcm.googleapis.com/fcm/send/x",
        "https://fcm.googleapis.com.evil.example/x",
        "https://evil.example/fcm.googleapis.com",
        "https://user@fcm.googleapis.com/x",
        "https://fcm.googleapis.com:8443/x",
        "https://push.services.mozilla.com/x",
        "https://notify.windows.com/x",
        "https://127.0.0.1/x",
        "https://FCM.googleapis.com/fcm/send/x", // only the canonical form is stored
        "https://fcm.googleapis.com", // no path: the canonical form has a slash
        "https://fcm.googleapis.com/fcm/send/../x",
        "not a url",
      ];
      for (const endpoint of bad) {
        await expect(push.subscribe(ada, body(endpoint))).rejects.toMatchObject({ name: "ZodError" });
      }
      const good = [FCM + "a", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://web.push.apple.com/x", "https://db5p.notify.windows.com/?token=x"];
      for (const endpoint of good) await push.subscribe(ada, body(endpoint), "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36");
      expect(await push.listDevices(ada)).toHaveLength(4);
      expect((await push.listDevices(ada))[0].deviceLabel).toBe("Chrome on Linux");
    });

    it("rejects malformed keys", async () => {
      const k = webPushKeys();
      for (const keys of [{ ...k, auth: "short" }, { ...k, p256dh: k.p256dh.slice(1) }, { p256dh: "A".repeat(87), auth: k.auth }, { p256dh: k.p256dh }]) {
        await expect(push.subscribe(ada, { endpoint: `${FCM}k`, keys })).rejects.toMatchObject({ name: "ZodError" });
      }
      await expect(push.subscribe(ada, { ...body(), extra: 1 })).rejects.toMatchObject({ name: "ZodError" });
      await expect(push.subscribe(ada, { ...body(), expirationTime: "soon" })).rejects.toMatchObject({ name: "ZodError" });
    });

    it("accepts what browsers send: PushSubscription.toJSON() includes expirationTime", async () => {
      await push.subscribe(ada, { ...body(`${FCM}exp-null`), expirationTime: null });
      await push.subscribe(ada, { ...body("https://web.push.apple.com/QGexp"), expirationTime: null });
      await push.subscribe(ada, { ...body(`${FCM}exp-num`), expirationTime: 1794200000000 });
      expect(await push.listDevices(ada)).toHaveLength(3);
    });

    it("moves an endpoint to the user who signs in last, when they present the same keys", async () => {
      const shared = body(`${FCM}shared`);
      await push.subscribe(ada, shared);
      await sql`update push_subscription set last_success_at = now(), failure_count = 3 where endpoint = ${shared.endpoint}`;
      await push.subscribe(ben, shared);
      expect(await push.listDevices(ada)).toHaveLength(0);
      expect(await push.listDevices(ben)).toHaveLength(1);
      expect(await sql`select 1 from push_subscription where endpoint = ${shared.endpoint}`).toHaveLength(1);
      // The new owner starts clean: no inherited delivery history.
      expect((await sql`select last_success_at, failure_count from push_subscription where endpoint = ${shared.endpoint}`)[0]).toEqual({ last_success_at: null, failure_count: 0 });
    });

    it("refuses to take an endpoint over without its keys: 409, and the owner keeps the row", async () => {
      const mine = body(`${FCM}victim`);
      await push.subscribe(ada, mine);
      const [before] = await sql`select id, user_id, p256dh, auth from push_subscription where endpoint = ${mine.endpoint}`;
      // Knowing only the endpoint (say, from a leaked URL) isn't enough, whatever keys are offered.
      for (const keys of [webPushKeys(), { p256dh: mine.keys.p256dh, auth: webPushKeys().auth }, { p256dh: webPushKeys().p256dh, auth: mine.keys.auth }]) {
        await expect(push.subscribe(ben, { endpoint: mine.endpoint, keys })).rejects.toMatchObject({ status: 409, message: "This device is set up for another account." });
      }
      await expect(push.subscribe(root, { endpoint: mine.endpoint, keys: webPushKeys() })).rejects.toMatchObject({ status: 409 });
      const [after] = await sql`select id, user_id, p256dh, auth from push_subscription where endpoint = ${mine.endpoint}`;
      expect(after).toEqual(before);
      expect(await push.listDevices(ben)).toHaveLength(0);
      // The refusal comes before the device cap and costs nothing: Ben's attempts rolled back with it.
      expect((await sql`select count(*)::int n from rate_event where user_id = ${ben.id}`)[0].n).toBe(0);
      // The owner can still replace their own keys (the browser rotated them).
      const rotated = { endpoint: mine.endpoint, keys: webPushKeys() };
      await push.subscribe(ada, rotated);
      expect((await sql`select p256dh from push_subscription where endpoint = ${mine.endpoint}`)[0].p256dh).toBe(rotated.keys.p256dh);
    });

    it("keeps at most 5 devices, replacing the oldest", async () => {
      for (let i = 0; i < 6; i++) {
        await push.subscribe(ada, body(`${FCM}dev${i}`));
        await sql`update push_subscription set created_at = now() - make_interval(mins => ${10 - i}) where endpoint = ${`${FCM}dev${i}`}`;
      }
      const devices = (await push.listDevices(ada)).map((d) => d.endpoint);
      expect(devices).toHaveLength(5);
      expect(devices).not.toContain(`${FCM}dev0`);
      expect(devices).toContain(`${FCM}dev5`);
    });

    it("limits subscribing to 20 an hour", async () => {
      await sql`insert into rate_event (user_id, kind) select ${ada.id}, 'subscribe' from generate_series(1, 20)`;
      await expect(push.subscribe(ada, body())).rejects.toMatchObject({ status: 429 });
    });

    it("lets only the owner remove a device, by endpoint or id; admin and others get 404", async () => {
      const d = await push.subscribe(ada, body(`${FCM}mine`));
      for (const intruder of [ben, root]) {
        await expect(push.unsubscribe(intruder, { id: d.id })).rejects.toMatchObject({ status: 404 });
        await expect(push.unsubscribe(intruder, { endpoint: d.endpoint })).rejects.toMatchObject({ status: 404 });
        expect(await push.listDevices(intruder)).toEqual([]);
      }
      expect(await push.listDevices(ada)).toHaveLength(1);
      await push.unsubscribe(ada, { endpoint: d.endpoint });
      expect(await push.listDevices(ada)).toHaveLength(0);
      await expect(push.unsubscribe(ada, { id: d.id })).rejects.toMatchObject({ status: 404 });
      const d2 = await push.subscribe(ada, body(`${FCM}mine2`));
      await push.unsubscribe(ada, { id: d2.id });
      expect(await push.listDevices(ada)).toHaveLength(0);
    });

    it("sends a test reminder to the caller's own devices only, 3 an hour", async () => {
      const mine = await device(ada);
      await device(ben);
      for (let i = 0; i < 3; i++) await push.sendTestPush(ada);
      await expect(push.sendTestPush(ada)).rejects.toMatchObject({ status: 429 });
      expect(new Set(sentTo())).toEqual(new Set([mine.endpoint]));
      expect(JSON.parse(state.send.mock.calls[0][1] as string).body).toMatch(/^Test reminder/);
      // With no device it is a 400 and doesn't use up an attempt.
      await expect(push.sendTestPush(cat)).rejects.toMatchObject({ status: 400 });
      expect((await sql`select count(*)::int n from rate_event where user_id = ${cat.id}`)[0].n).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("routes", () => {
    it("requires sign-in and our own origin, and only ever returns the public key", async () => {
      const config = await import("@/app/api/push/config/route");
      const subs = await import("@/app/api/push/subscriptions/route");
      const test = await import("@/app/api/push/test/route");
      state.user = null;
      expect((await config.GET()).status).toBe(401);
      expect((await subs.GET()).status).toBe(401);
      expect((await subs.POST(json("POST", {}))).status).toBe(401);
      expect((await test.POST(json("POST"))).status).toBe(401);

      state.user = ada;
      const cfg = await (await config.GET()).json();
      const { publicKey, privateKey } = await vapid.getVapidKeys();
      expect(cfg).toEqual({ enabled: true, publicKey });
      expect(JSON.stringify(cfg)).not.toContain(privateKey);

      const payload = { endpoint: `${FCM}route`, keys: webPushKeys() };
      expect((await subs.POST(json("POST", payload, { origin: "https://evil.example" }))).status).toBe(403);
      expect((await subs.POST(json("POST", { ...payload, endpoint: "https://evil.example/" }))).status).toBe(400);
      const created = await subs.POST(json("POST", payload, { "user-agent": "Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36" }));
      expect(created.status).toBe(201);
      const listed = await (await subs.GET()).json();
      expect(listed.devices).toMatchObject([{ endpoint: payload.endpoint, deviceLabel: "Chrome on Android" }]);
      expect(JSON.stringify(listed)).not.toMatch(/p256dh|auth"/);
      expect((await test.POST(json("POST", undefined, { origin: "https://evil.example" }))).status).toBe(403);
      expect(await (await test.POST(json("POST"))).json()).toEqual({ sent: 1, removed: 0, failed: 0 });
      expect((await subs.DELETE(json("DELETE", { endpoint: payload.endpoint }, { origin: "https://evil.example" }))).status).toBe(403);
      state.user = ben;
      expect((await subs.DELETE(json("DELETE", { endpoint: payload.endpoint }))).status).toBe(404);
      state.user = ada;
      expect((await subs.DELETE(json("DELETE", { endpoint: payload.endpoint }))).status).toBe(204);
    });
  });

  // -------------------------------------------------------------------------
  describe("VAPID keys", () => {
    it("5 concurrent loads on separate connections against an empty table agree on one pair and leave one row", async () => {
      await sql`delete from push_subscription`;
      await sql`delete from app_settings`;
      const clients = Array.from({ length: 5 }, () => postgres(url!, { max: 1, onnotice: () => {} }));
      try {
        const results = await Promise.all(clients.map((c) => vapid.loadOrCreateVapidKeys(drizzle(c, { schema: dbm.schema }))));
        expect(new Set(results.map((r) => `${r.publicKey}|${r.privateKey}|${r.keyId}`)).size).toBe(1);
        expect(await sql`select 1 from app_settings`).toHaveLength(1);
        const [row] = await sql`select vapid_public_key, vapid_private_key, vapid_key_id from app_settings`;
        expect(results[0]).toEqual({ publicKey: row.vapid_public_key, privateKey: row.vapid_private_key, keyId: row.vapid_key_id });
        expect(row.vapid_key_id).toMatch(/^[0-9a-f]{8}$/);
      } finally {
        await Promise.all(clients.map((c) => c.end()));
      }
    });

    it("gives a new pair after the row is deleted, prunes old-key subscriptions, and never exposes the private key", async () => {
      const lines: string[] = [];
      for (const m of ["log", "error"] as const) vi.spyOn(console, m).mockImplementation((l: unknown) => void lines.push(String(l)));
      vapid.resetVapidCache();
      const oldKeys = await vapid.getVapidKeys();
      const stale = await device(ada);
      expect(await vapid.getVapidKeys()).toEqual(oldKeys); // cached

      await sql`delete from app_settings`;
      vapid.resetVapidCache(); // a restart
      const fresh = await vapid.getVapidKeys();
      expect(fresh.publicKey).not.toBe(oldKeys.publicKey);
      expect(fresh.privateKey).not.toBe(oldKeys.privateKey);
      expect(fresh.keyId).not.toBe(oldKeys.keyId);
      expect(await sql`select 1 from push_subscription where id = ${stale.id}`).toHaveLength(0);
      expect(await sql`select 1 from app_settings`).toHaveLength(1);

      // Everything a client can see: config, health, subscribe responses; and every log line.
      state.user = ada;
      const config = await import("@/app/api/push/config/route");
      const health = await import("@/app/api/health/route");
      const subs = await import("@/app/api/push/subscriptions/route");
      const created = await subs.POST(json("POST", { endpoint: `${FCM}k1`, keys: webPushKeys() }));
      const seen = [await (await config.GET()).text(), await (await health.GET()).text(), await created.text()];
      expect(JSON.parse(seen[1]).push).toBe("on");
      for (const text of [...seen, ...lines]) expect(text).not.toContain(fresh.privateKey);
      expect(lines.join("\n")).toContain("vapid.pruned_subscriptions");
    });

    it("never logs the private key when creating it fails (subscribe, runReminders, vapidKeysOrNull, routes)", async () => {
      const lines: string[] = [];
      for (const m of ["log", "error", "warn"] as const) vi.spyOn(console, m).mockImplementation((l: unknown) => void lines.push(String(l)));
      await sql`delete from push_subscription`;
      await sql`delete from app_settings`;
      await sql`create or replace function pu_boom() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$`;
      await sql`create trigger pu_boom before insert on app_settings for each row execute function pu_boom()`;
      const seen: string[] = [];
      try {
        state.pairs.length = 0;
        const fresh = () => vapid.resetVapidCache();

        fresh();
        const err = await vapid.getVapidKeys().then(() => null, (e: Error) => e);
        expect(err?.message).toBe("VAPID key load failed (P0001)");
        seen.push(String(err?.stack));

        fresh();
        const failed = await push.subscribe(ada, { endpoint: `${FCM}x`, keys: webPushKeys() }).then(() => null, (e: Error & { status?: number }) => e);
        expect(failed).toMatchObject({ status: 503, message: "Reminders aren't available right now." });
        seen.push(String(failed?.stack));

        fresh();
        expect(await push.runReminders(utc("2026-11-08T15:10:00Z"))).toEqual({ skipped: "unavailable" });
        fresh();
        expect(await push.vapidKeysOrNull()).toBeNull();

        state.user = ada;
        fresh();
        const config = await import("@/app/api/push/config/route");
        const subs = await import("@/app/api/push/subscriptions/route");
        const cfg = await config.GET();
        expect(await cfg.clone().json()).toEqual({ enabled: false, publicKey: null });
        seen.push(await cfg.text());
        fresh();
        const sub = await subs.POST(json("POST", { endpoint: `${FCM}y`, keys: webPushKeys() }));
        expect(sub.status).toBe(503);
        seen.push(await sub.text());

        // The premise: Drizzle's own error does carry the parameters, so without the wrapper this would leak.
        const pair = state.pairs[0];
        const raw = await dbm.db().insert(dbm.schema.appSettings).values({ id: 1, vapidPublicKey: pair.publicKey, vapidPrivateKey: pair.privateKey, vapidKeyId: "abcdef12" }).then(() => null, (e: Error) => e);
        expect(raw?.message).toContain(pair.privateKey);
      } finally {
        await sql`drop trigger if exists pu_boom on app_settings`;
        await sql`drop function if exists pu_boom()`;
      }
      expect(state.pairs.length).toBeGreaterThan(0);
      for (const { privateKey } of state.pairs) {
        for (const text of [...lines, ...seen]) expect(text).not.toContain(privateKey);
      }
      // And the logs did record that it failed.
      expect(lines.join("\n")).toContain("VAPID key load failed (P0001)");
    });

    it("sets a statement timeout on the pool, so a stuck query can't hold a reminder run", async () => {
      const [row] = await dbm.db().execute<{ statement_timeout: string }>(dsql`show statement_timeout`);
      expect(row.statement_timeout).toBe("30s");
    });

    it("is cached per process, sharing one in-flight load", async () => {
      vapid.resetVapidCache();
      const [a, b] = await Promise.all([vapid.getVapidKeys(), vapid.getVapidKeys()]);
      expect(a).toBe(b);
      expect(vapid.vapidLoaded()).toBe(true);
    });
  });
});
