"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { shortDay, weekdayName } from "@/lib/format";
import { CheckInControl, type CheckInHabit, type CheckInState } from "./check-in-control";

export type RecentDay = { date: string; value: string | null; done: boolean; label: string };

/** The editable window: today and the 7 days before it, each with the same control as the Today page. */
export function RecentDays({ habit, days }: { habit: CheckInHabit; days: RecentDay[] }) {
  const router = useRouter();
  const [state, setState] = useState<Record<string, CheckInState>>(() =>
    Object.fromEntries(days.map((d) => [d.date, { value: d.value, done: d.done }])),
  );
  if (days.length === 0) {
    return (
      <p className="rounded-card bg-background px-4 py-6 text-center text-sm text-muted">
        No days to edit yet. <Link href="/today" className="font-semibold text-accent hover:underline">Check in on Today</Link>.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border">
      {days.map((d) => (
        <li key={d.date} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <p className="font-medium sm:w-44 sm:shrink-0">
            {d.label && <span className="mr-2">{d.label}</span>}
            <span className="whitespace-nowrap font-normal text-muted">{weekdayName(d.date)}, {shortDay(d.date)}</span>
          </p>
          <div className="sm:ml-auto sm:w-64 sm:shrink-0">
          <CheckInControl
            habit={habit}
            date={d.date}
            state={state[d.date]}
            onChange={(s) => setState((cur) => ({ ...cur, [d.date]: s }))}
            onSaved={() => router.refresh()}
          />
          </div>
        </li>
      ))}
    </ul>
  );
}
