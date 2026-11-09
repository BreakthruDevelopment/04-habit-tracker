import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => {
  let resolve: () => void = () => {};
  return {
    gate: new Promise<void>((r) => (resolve = r)),
    open: () => resolve(),
    start: vi.fn(),
    warm: vi.fn().mockResolvedValue({}),
    migrate: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("./lib/db/migrate-on-start", () => ({ migrateOnStart: m.migrate, whenMigrated: () => m.gate }));
vi.mock("./lib/reminder-scheduler", () => ({ startReminderScheduler: m.start }));
vi.mock("./lib/vapid", () => ({ getVapidKeys: m.warm }));

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

describe("register", () => {
  beforeEach(() => {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.DATABASE_URL = "postgres://x";
  });
  afterEach(() => {
    delete process.env.NEXT_RUNTIME;
  });

  it("doesn't block startup, and starts the VAPID warm-up and scheduler only after whenMigrated() resolves", async () => {
    const { register } = await import("./instrumentation");
    await register(); // returns although migrations are still pending
    await flush();
    expect(m.warm).not.toHaveBeenCalled();
    expect(m.start).not.toHaveBeenCalled();
    m.open();
    await flush();
    expect(m.warm).toHaveBeenCalledTimes(1);
    expect(m.start).toHaveBeenCalledTimes(1);
    expect(m.warm.mock.invocationCallOrder[0]).toBeLessThan(m.start.mock.invocationCallOrder[0]);
  });

  it("still starts the scheduler when the VAPID warm-up fails", async () => {
    m.warm.mockRejectedValueOnce(new Error("db down"));
    m.start.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { register } = await import("./instrumentation");
    await register();
    await flush();
    expect(m.start).toHaveBeenCalledTimes(1);
  });

  it("does nothing outside the Node runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";
    m.start.mockClear();
    const { register } = await import("./instrumentation");
    await register();
    await flush();
    expect(m.start).not.toHaveBeenCalled();
  });
});
