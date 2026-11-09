import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const pingDb = vi.fn();
vi.mock("@/lib/db", () => ({ pingDb: () => pingDb() }));
const vapid = vi.hoisted(() => ({ loaded: false, getVapidKeys: vi.fn() }));
vi.mock("@/lib/vapid", () => ({ vapidLoaded: () => vapid.loaded, getVapidKeys: vapid.getVapidKeys }));

import { GET } from "@/app/api/health/route";
import { migrateOnStart, migrationState, whenMigrated } from "./migrate-on-start";

const KEY = Symbol.for("30apps.migrationState");
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[KEY];
  pingDb.mockResolvedValue(true);
  vapid.loaded = false;
  vapid.getVapidKeys.mockRejectedValue(new Error("no keys"));
});

describe("migrateOnStart", () => {
  it("marks ok when the first attempt succeeds", async () => {
    const runOnce = vi.fn().mockResolvedValue(undefined);
    await migrateOnStart({ runOnce, sleep: async () => {}, delays: [1, 1] });
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(migrationState()).toBe("ok");
  });

  it("retries in the background until the database exists", async () => {
    const runOnce = vi
      .fn()
      .mockRejectedValueOnce(new Error('database "x" does not exist'))
      .mockRejectedValueOnce(new Error('database "x" does not exist'))
      .mockResolvedValue(undefined);
    await migrateOnStart({ runOnce, sleep: async () => {}, delays: [1, 1, 1] });
    for (let i = 0; i < 20 && migrationState() !== "ok"; i++) await flush();
    expect(runOnce).toHaveBeenCalledTimes(3);
    expect(migrationState()).toBe("ok");
  });

  it("keeps retrying past the end of the backoff list", async () => {
    let calls = 0;
    const runOnce = vi.fn(async () => {
      if (++calls < 6) throw new Error("down");
    });
    await migrateOnStart({ runOnce, sleep: async () => {}, delays: [1, 1] });
    for (let i = 0; i < 40 && migrationState() !== "ok"; i++) await flush();
    expect(runOnce).toHaveBeenCalledTimes(6);
    expect(migrationState()).toBe("ok");
  });

  it("does not start a second loop while one is retrying", async () => {
    const runOnce = vi.fn().mockRejectedValue(new Error("down"));
    await migrateOnStart({ runOnce, sleep: () => new Promise(() => {}), delays: [1] });
    expect(migrationState()).toBe("retrying");
    await migrateOnStart({ runOnce, sleep: async () => {}, delays: [1] });
    expect(runOnce).toHaveBeenCalledTimes(1);
  });
});

describe("/api/health", () => {
  it("is 503 with checks.migrations while retrying", async () => {
    await migrateOnStart({ runOnce: vi.fn().mockRejectedValue(new Error("down")), sleep: () => new Promise(() => {}), delays: [1] });
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: "degraded", checks: { database: "ok", migrations: "retrying" } });
  });

  it("is 200 once migrated, and 200 without migrate-on-start", async () => {
    expect((await GET()).status).toBe(200);
    await migrateOnStart({ runOnce: vi.fn().mockResolvedValue(undefined), sleep: async () => {}, delays: [1] });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ checks: { migrations: "ok" } });
  });

  it("reports push on once the VAPID keys load, and off when they can't (never a key)", async () => {
    let body = await (await GET()).json();
    expect(body.push).toBe("off");
    expect((await GET()).status).toBe(200);
    vapid.getVapidKeys.mockResolvedValue({ publicKey: "pub", privateKey: "secret-private", keyId: "abcd1234" });
    body = await (await GET()).json();
    expect(body.push).toBe("on");
    expect(JSON.stringify(body)).not.toContain("secret-private");
  });

  it("is 503 when the database is unreachable", async () => {
    pingDb.mockResolvedValue(false);
    expect((await GET()).status).toBe(503);
  });
});

describe("whenMigrated", () => {
  const settled = async (p: Promise<void>) => {
    let done = false;
    void p.then(() => (done = true));
    await flush();
    return done;
  };

  it("resolves at once when migrations were skipped or aren't managed by this process", async () => {
    expect(await settled(whenMigrated())).toBe(true); // state never set
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    await migrateOnStart();
    process.env.DATABASE_URL = prev;
    expect(migrationState()).toBe("skipped");
    expect(await settled(whenMigrated())).toBe(true);
  });

  it("resolves at once after success", async () => {
    await migrateOnStart({ runOnce: async () => {}, sleep: async () => {}, delays: [1] });
    expect(await settled(whenMigrated())).toBe(true);
  });

  it("stays pending while migrations retry, then resolves when one succeeds", async () => {
    let calls = 0;
    const runOnce = vi.fn(async () => {
      if (++calls < 3) throw new Error("db not ready");
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await migrateOnStart({ runOnce, sleep: () => gate, delays: [1] });
    expect(migrationState()).toBe("retrying");
    const waiting = whenMigrated();
    expect(await settled(waiting)).toBe(false);
    // Let the background loop run its attempts; the second attempt still fails, the third succeeds.
    release();
    await waiting;
    expect(migrationState()).toBe("ok");
    expect(runOnce).toHaveBeenCalledTimes(3);
  });
});
