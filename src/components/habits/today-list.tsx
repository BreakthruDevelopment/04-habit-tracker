"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Panel, buttonPrimary } from "@/components/ui";
import { plural, weekdayName } from "@/lib/format";
import { CheckInControl, type CheckInState } from "./check-in-control";
import { type Dot, WeekDots } from "./week-dots";

export type TodayItem = {
  id: string;
  name: string;
  kind: "check" | "numeric";
  unit: string | null;
  dailyTarget: string | null;
  weeklyGoal: number;
  value: string | null;
  done: boolean;
  streak: { mode: "day" | "week"; current: number; best: number };
  week: { dots: { date: string; done: boolean; value: string | null }[]; doneDays: number };
};

/** Today's check-in changes the matching dot and the week count straight away; streaks come back from the server. */
function withState(h: TodayItem, date: string, s: CheckInState): TodayItem {
  const dots = h.week.dots.map((d) => (d.date === date ? { ...d, done: s.done, value: s.value } : d));
  return { ...h, ...s, week: { dots, doneDays: dots.filter((d) => d.done).length } };
}

function streakText(s: TodayItem["streak"]): string {
  if (s.current === 0) return s.best > 0 ? `No streak right now (best ${s.best})` : "No streak yet";
  const unit = s.mode === "day" ? "day" : "week";
  return `${plural(s.current, unit)} streak${s.best > s.current ? ` (best ${s.best})` : ""}`;
}

function dotsFor(h: TodayItem, date: string): Dot[] {
  return h.week.dots.map((d) => ({
    key: d.date,
    label: weekdayName(d.date),
    today: d.date === date,
    state: d.done ? "done" : d.value !== null ? "partial" : d.date > date ? "future" : "none",
  }));
}

/** The authoritative copy from GET /api/today, used to refresh streaks after a save. */
function fromApi(body: { habits?: Record<string, unknown>[] }): TodayItem[] | null {
  if (!Array.isArray(body.habits)) return null;
  return body.habits.map((h) => ({
    id: h.id as string,
    name: h.name as string,
    kind: h.kind as TodayItem["kind"],
    unit: (h.unit as string | null) ?? null,
    dailyTarget: (h.dailyTarget as string | null) ?? null,
    weeklyGoal: h.weeklyGoal as number,
    value: (h.value as string | null) ?? null,
    done: Boolean(h.done),
    streak: h.streak as TodayItem["streak"],
    week: h.week as TodayItem["week"],
  }));
}

export function TodayList({ date, initial }: { date: string; initial: TodayItem[] }) {
  const router = useRouter();
  const [habits, setHabits] = useState(initial);
  const busy = useRef(0);
  const epoch = useRef(0);

  function change(id: string, s: CheckInState) {
    setHabits((hs) => hs.map((h) => (h.id === id ? withState(h, date, s) : h)));
  }

  function setBusy(isBusy: boolean) {
    busy.current += isBusy ? 1 : -1;
    if (isBusy) epoch.current += 1;
  }

  /** Streaks depend on other days, so ask the server. Skipped while any save is still in flight. */
  async function refresh() {
    if (busy.current > 0) return;
    const mine = epoch.current;
    try {
      const res = await fetch("/api/today", { cache: "no-store" });
      if (!res.ok) return;
      const body = await res.json();
      // The day rolled over (or the zone changed) since this page loaded: reload the server-rendered page.
      if (body.date !== date) {
        router.refresh();
        return;
      }
      const next = fromApi(body);
      if (next && mine === epoch.current && busy.current === 0) setHabits(next);
    } catch {
      // The optimistic numbers are already right; streaks catch up on the next load.
    }
  }

  const doneCount = habits.filter((h) => h.done).length;
  const pct = habits.length === 0 ? 0 : Math.round((100 * doneCount) / habits.length);

  if (habits.length === 0) {
    return (
      <Panel title="Today's habits">
        <div className="space-y-4 rounded-card bg-background px-4 py-8 text-center">
          <p className="font-display text-2xl font-semibold">Add your first habit</p>
          <p className="text-muted">Pick something small you want to do every day. Checking it off takes two taps.</p>
          <Link href="/habits" className={buttonPrimary}>
            Add a habit
          </Link>
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title="Today's habits"
      action={
        <p role="status" className="text-base font-semibold">
          {doneCount} of {habits.length} done
        </p>
      }
    >
      <div aria-hidden className="mb-4 h-2 overflow-hidden rounded-full bg-idle-soft">
        <div className="h-full rounded-full bg-live transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <ul className="divide-y divide-border">
        {habits.map((h) => (
          <li key={h.id} className="flex flex-col gap-4 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-3">
              <div className="space-y-1">
                <h3 className="break-words font-semibold">
                  <Link href={`/habits/${h.id}`} className="inline-flex min-h-11 min-w-11 items-center text-foreground hover:text-accent hover:underline">
                    {h.name}
                  </Link>
                </h3>
                {h.kind === "numeric" && (
                  <p className="text-sm text-muted tabular-nums">
                    {h.value ?? "0"} / {h.dailyTarget} {h.unit}
                  </p>
                )}
                <p className="text-sm text-muted">{streakText(h.streak)}</p>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <WeekDots dots={dotsFor(h, date)} label={`${h.name}, this week`} />
                <p className={`text-sm font-medium tabular-nums ${h.week.doneDays >= h.weeklyGoal ? "text-live" : "text-muted"}`}>
                  {h.week.doneDays} / {h.weeklyGoal} this week
                </p>
              </div>
            </div>
            <div className="shrink-0">
              <CheckInControl
                habit={h}
                date={date}
                state={{ value: h.value, done: h.done }}
                onChange={(s) => change(h.id, s)}
                onBusy={setBusy}
                onSaved={() => void refresh()}
              />
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
