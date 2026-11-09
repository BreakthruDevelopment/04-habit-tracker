import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startReminderScheduler, stopReminderScheduler } from "@/lib/reminder-scheduler";

const MIN = 60_000;

describe("startReminderScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.REMINDER_SCHEDULER;
  });
  afterEach(() => {
    stopReminderScheduler();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.REMINDER_SCHEDULER;
  });

  it("starts one interval however often it is called: first tick 30 to 60 s in, then every 5 minutes", async () => {
    const run = vi.fn().mockResolvedValue({ considered: 0 });
    expect(startReminderScheduler({ run, random: () => 0 })).toBe(true);
    expect(startReminderScheduler({ run, random: () => 0 })).toBe(false);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toBeInstanceOf(Date);
    await vi.advanceTimersByTimeAsync(5 * MIN - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(run).toHaveBeenCalledTimes(4); // one timer, not two
  });

  it("delays the first tick by up to 60 s", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    startReminderScheduler({ run, random: () => 0.999 });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("logs a tick that throws and still runs the next one", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValue({});
    startReminderScheduler({ run, random: () => 0 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("reminders.tick_failed"));
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("skips a tick while the previous one is still running", async () => {
    let finish: () => void = () => {};
    const run = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    startReminderScheduler({ run, random: () => 0 });
    await vi.advanceTimersByTimeAsync(30_000 + 12 * MIN);
    expect(run).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("reminders.tick_skipped"));
    finish();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("starts nothing with REMINDER_SCHEDULER=off", async () => {
    process.env.REMINDER_SCHEDULER = "off";
    const run = vi.fn();
    expect(startReminderScheduler({ run })).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(run).not.toHaveBeenCalled();
  });
});
