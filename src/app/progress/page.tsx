import type { Metadata } from "next";
import Link from "next/link";
import { CoachPanel } from "@/components/coach/coach-panel";
import { FreeTierBanner } from "@/components/habits/free-tier-banner";
import { Heatmap } from "@/components/habits/heatmap";
import { type Dot, WeekDots } from "@/components/habits/week-dots";
import { type Column, DataList, DemoBadge, PageIntro, Panel, StatGrid, StatTile, StatusBadge, buttonSecondary } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { isDemoEmail } from "@/lib/demo-identity";
import { BadRequestError } from "@/lib/errors";
import { shortDay, weekdayName } from "@/lib/format";
import { listHabits } from "@/lib/habits";
import { type WeekHabit, type WeekSummary, heatmap, streaks, weekSummary } from "@/lib/progress";
import { addDays, parseIsoWeek } from "@/lib/time";

export const metadata: Metadata = { title: "Progress" };
export const dynamic = "force-dynamic";

const disabledLink =
  "inline-flex min-h-11 items-center justify-center rounded-card border border-border px-4 text-sm font-semibold text-muted opacity-60";

/** A week's label as a date range: "Nov 2 to Nov 8". */
const range = (week: string) => {
  const monday = parseIsoWeek(week);
  return `${shortDay(monday)} to ${shortDay(addDays(monday, 6))}`;
};

function WeekToggle({ summary }: { summary: WeekSummary }) {
  // The links carry the server's own prev/next labels, so they round-trip through `?week=`.
  const href = (week: string) => `/progress?week=${week}`;
  return (
    <nav aria-label="Choose a week" className="mb-6 flex flex-wrap items-center gap-3">
      {summary.prev ? (
        <Link href={href(summary.prev)} className={buttonSecondary} aria-label={`Previous week, ${summary.prev}`}>
          <span aria-hidden>←</span> {range(summary.prev)}
        </Link>
      ) : (
        <span aria-disabled="true" className={disabledLink}>
          No earlier weeks
        </span>
      )}
      <p className="min-w-0 flex-1 text-center font-semibold sm:flex-none sm:px-2" aria-current="page">
        {summary.isCurrent ? "This week" : summary.week}
        <span className="block text-sm font-normal text-muted">
          {shortDay(summary.monday)} to {shortDay(summary.sunday)}
        </span>
      </p>
      {summary.next ? (
        <Link
          href={href(summary.next)}
          className={buttonSecondary}
          aria-label={`Next week, ${summary.next}`}
        >
          {range(summary.next)} <span aria-hidden>→</span>
        </Link>
      ) : (
        <span aria-disabled="true" className={disabledLink}>
          This is the latest week
        </span>
      )}
    </nav>
  );
}

/** In the current week a goal that can still be met is "Not yet", not "Behind". Today still counts if it's open. */
function reachable(h: WeekHabit, s: WeekSummary): boolean {
  if (!s.isCurrent) return false;
  const todayOpen = h.done[s.daysElapsed - 1] ? 0 : 1;
  return h.doneDays + (7 - s.daysElapsed) + todayOpen >= h.weeklyGoal;
}

function dotsFor(h: WeekHabit, s: WeekSummary): Dot[] {
  return h.values.map((v, i) => {
    const date = addDays(s.monday, i);
    const state: Dot["state"] =
      v === null
        ? i >= s.daysElapsed
          ? "future"
          : "none"
        : h.done[i]
          ? "done"
          : "partial";
    return { key: date, label: weekdayName(date), state };
  });
}

export default async function ProgressPage({ searchParams }: { searchParams: Promise<{ week?: string | string[] }> }) {
  const user = await requireUserOrRedirect();
  const sp = await searchParams;
  const weekParam = Array.isArray(sp.week) ? sp.week[0] : sp.week;
  const demoUser = isDemoEmail(user.email);

  let summary: WeekSummary | null = null;
  let weekError = "";
  try {
    summary = await weekSummary(user, weekParam || null);
  } catch (err) {
    if (!(err instanceof BadRequestError)) throw err;
    weekError = err.message;
  }

  const intro = (
    <PageIntro
      section="Progress"
      title="Your progress"
      description="How the week is going, and the last 30 days at a glance."
      actions={demoUser ? <DemoBadge /> : undefined}
    />
  );

  if (!summary) {
    return (
      <>
        {intro}
        <FreeTierBanner />
        <Panel title="That week isn't available">
          <p role="alert" className="mb-4 break-words text-sm font-medium text-danger">
            {weekError}
          </p>
          <Link href="/progress" className={buttonSecondary}>
            Back to this week
          </Link>
        </Panel>
      </>
    );
  }

  const [map, streakMap, active] = await Promise.all([heatmap(user), streaks(user), listHabits(user)]);
  const names = new Map(active.map((h) => [h.id, h.name]));
  // Day streaks and week streaks aren't the same length; compare them on one scale (a week counts as 7 days).
  const best = Object.entries(streakMap)
    .map(([id, s]) => ({ id, s, days: s.mode === "week" ? s.current * 7 : s.current }))
    .filter((x) => x.s.current > 0)
    .sort((a, b) => b.days - a.days)[0];
  const { totals } = summary;

  const columns: Column<WeekHabit>[] = [
    {
      key: "habit",
      header: "Habit",
      primary: true,
      cell: (h) => (
        <Link href={`/habits/${h.habitId}`} className="inline-flex min-h-11 items-center font-semibold text-accent hover:underline">
          {h.name}
        </Link>
      ),
    },
    { key: "week", header: "Days", cell: (h) => <WeekDots dots={dotsFor(h, summary)} label={`${h.name}, ${summary.week}`} /> },
    {
      key: "done",
      header: "Done / goal",
      className: "tabular-nums whitespace-nowrap",
      cell: (h) => (
        <span className="inline-flex items-center gap-2">
          {h.doneDays} of {h.weeklyGoal}
          {h.goalMet ? (
            <StatusBadge status="passed" label="On goal" />
          ) : reachable(h, summary) ? (
            <StatusBadge status="not-started" label="Not yet" />
          ) : (
            <StatusBadge status="building" label="Behind" />
          )}
        </span>
      ),
    },
    {
      key: "total",
      header: "Total",
      className: "tabular-nums whitespace-nowrap",
      cell: (h) => (h.kind === "numeric" ? `${h.total} ${h.unit}` : "–"),
    },
    { key: "last", header: "Last week", className: "tabular-nums whitespace-nowrap", cell: (h) => `${h.lastWeekDoneDays} of ${h.weeklyGoal}` },
  ];

  return (
    <>
      {intro}
      <FreeTierBanner />
      <WeekToggle summary={summary} />

      <StatGrid>
        <StatTile value={`${totals.completionPct}%`} label="Completion" tone="accent" />
        <StatTile value={`${totals.habitsOnGoal} of ${totals.habits}`} label="Habits on goal" tone={totals.habits > 0 && totals.habitsOnGoal === totals.habits ? "live" : "default"} />
        <StatTile
          value={best ? best.s.current : "–"}
          label={best ? `Best current streak: ${names.get(best.id) ?? "a habit"}, ${best.s.mode === "week" ? "weeks" : "days"}` : "No streak yet"}
          tone={best ? "live" : "default"}
        />
        <StatTile value={totals.doneCheckIns} label="Check-ins done" />
      </StatGrid>

      <div className="grid gap-x-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <Panel title="Last 30 days">
          <Heatmap
            days={map.days}
            label="All habits, last 30 days"
            legend="Darker means more of your habits were done that day. The ringed cell is today."
            describe={(d) => `${shortDay(d.date)}: ${d.done} of ${d.total}`}
          />
        </Panel>
        <Panel title={summary.isCurrent ? "This week by habit" : `Week ${summary.week} by habit`}>
          <DataList
            caption={`Habits for ${summary.week}`}
            columns={columns}
            rows={summary.habits}
            rowKey={(h) => h.habitId}
            empty={
              <>
                No habits were active this week. <Link href="/habits" className="font-semibold text-accent hover:underline">Add a habit</Link>.
              </>
            }
          />
        </Panel>
      </div>

      <div data-slot="coach-panel">
        <CoachPanel key={summary.week} week={summary.week} />
      </div>
    </>
  );
}
