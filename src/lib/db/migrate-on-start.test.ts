import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const pingDb = vi.fn();
vi.mock("@/lib/db", () => ({ pingDb: () => pingDb() }));

import { GET } from "@/app/api/health/route";
import { migrateOnStart, migrationState } from "./migrate-on-start";

const KEY = Symbol.for("30apps.migrationState");
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[KEY];
  pingDb.mockResolvedValue(true);
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

  it("is 503 when the database is unreachable", async () => {
    pingDb.mockResolvedValue(false);
    expect((await GET()).status).toBe(503);
  });
});
