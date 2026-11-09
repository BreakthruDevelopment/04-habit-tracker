import { log } from "@/lib/log";

const TICK_MS = 5 * 60_000;
const FIRST_MIN_MS = 30_000;
const FIRST_SPREAD_MS = 30_000;

type Deps = {
  run?: (now: Date) => Promise<unknown>;
  random?: () => number;
};

type State = { first?: ReturnType<typeof setTimeout>; every?: ReturnType<typeof setInterval>; busy: boolean };

// A globalThis flag makes this start once per process even if instrumentation and routes load separate module copies.
const KEY = Symbol.for("30apps.reminderScheduler");
type Holder = { [KEY]?: State };

/**
 * Start the in-process reminder scheduler (the only trigger for reminders). The first tick runs 30 to 60 s from now,
 * then every 5 minutes. A tick that throws is logged and the next still runs; a tick that starts while the previous
 * one is still going is skipped. Several instances are safe: `runReminders` takes an advisory lock and claims
 * before sending. Returns false when it didn't start (already started, or REMINDER_SCHEDULER=off).
 */
export function startReminderScheduler(deps: Deps = {}): boolean {
  const holder = globalThis as Holder;
  if (holder[KEY]) return false;
  if (process.env.REMINDER_SCHEDULER === "off") {
    log.info("reminders.scheduler_off");
    return false;
  }
  const state: State = { busy: false };
  holder[KEY] = state;
  const run =
    deps.run ??
    (async (now: Date) => {
      const { runReminders } = await import("@/lib/push");
      return runReminders(now);
    });

  const tick = async () => {
    if (state.busy) {
      log.warn("reminders.tick_skipped", { reason: "previous tick still running" });
      return;
    }
    state.busy = true;
    try {
      const result = await run(new Date());
      log.info("reminders.tick", { result });
    } catch (err) {
      log.error("reminders.tick_failed", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      state.busy = false;
    }
  };

  const delay = FIRST_MIN_MS + Math.floor((deps.random ?? Math.random)() * FIRST_SPREAD_MS);
  state.first = setTimeout(() => {
    void tick();
    state.every = setInterval(() => void tick(), TICK_MS);
    state.every.unref?.();
  }, delay);
  state.first.unref?.();
  log.info("reminders.scheduler_started", { firstTickMs: delay });
  return true;
}

/** For tests only. */
export function stopReminderScheduler(): void {
  const holder = globalThis as Holder;
  const state = holder[KEY];
  if (!state) return;
  if (state.first) clearTimeout(state.first);
  if (state.every) clearInterval(state.every);
  holder[KEY] = undefined;
}
