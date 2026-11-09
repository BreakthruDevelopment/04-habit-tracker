import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FreeTierBanner } from "@/components/habits/free-tier-banner";
import { Heatmap } from "@/components/habits/heatmap";
import { RecentDays, type RecentDay } from "@/components/habits/recent-days";
import { type Column, DataList, DemoBadge, PageIntro, Panel, StatGrid, StatTile, StatusBadge, buttonSecondary } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { isDemoEmail } from "@/lib/demo-identity";
import { NotFoundError } from "@/lib/errors";
import { plural, shortDay } from "@/lib/format";
import { type HabitProgress, habitProgress, heatmap } from "@/lib/progress";
import { getLocalDay } from "@/lib/settings";
import { localTodayFor } from "@/lib/time";

export const metadata: Metadata = { title: "Habit" };
export const dynamic = "force-dynamic";

type Week = HabitProgress["weeks"][number];

export default async function HabitDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUserOrRedirect();
  const { id } = await params;
  // Someone else's habit, a deleted one and a malformed id are all the same 404.
  const progress = await habitProgress(user, id).catch((err: unknown) => {
    if (err instanceof NotFoundError) return null;
    throw err;
  });
  if (!progress) notFound();
  const { habit, streak, weeks, hitRate, recent } = progress;
  const [map, day] = await Promise.all([heatmap(user, { habitId: habit.id }), getLocalDay(user, new Date())]);
  const archived = habit.archivedAt !== null;
  const createdOn = localTodayFor(day.timeZone, habit.createdAt);
  const editable: RecentDay[] = recent
    .filter((r) => r.date >= createdOn)
    .map((r, i) => ({ ...r, label: i === 0 ? "Today" : i === 1 ? "Yesterday" : "" }));
  const skipped = recent.length - editable.length;
  const unit = streak.mode === "day" ? "day" : "week";
  const met = weeks.filter((w) => w.goalMet).length;

  const columns: Column<Week>[] = [
    { key: "week", header: "Week of", primary: true, cell: (w) => shortDay(w.monday) },
    { key: "days", header: "Days done", className: "tabular-nums", cell: (w) => `${w.doneDays} of ${habit.weeklyGoal}` },
    {
      key: "goal",
      header: "Goal",
      cell: (w) => (w.goalMet ? <StatusBadge status="passed" label="Met" /> : <StatusBadge status="not-started" label="Not met" />),
    },
  ];

  const target = habit.dailyTarget;
  return (
    <>
      <PageIntro
        section="Habit"
        title={habit.name}
        description={
          habit.kind === "numeric"
            ? `${target} ${habit.unit} a day, ${habit.weeklyGoal} days a week.`
            : `Yes or no, ${habit.weeklyGoal === 7 ? "every day" : `${habit.weeklyGoal} days a week`}.`
        }
        actions={
          <>
            <Link href="/habits" className={buttonSecondary}>
              Back to habits
            </Link>
            {isDemoEmail(user.email) && (
              <span className="inline-flex min-h-11 items-center">
                <DemoBadge />
              </span>
            )}
            {archived && (
              <span className="inline-flex min-h-11 items-center">
                <StatusBadge status="not-started" label="Archived" />
              </span>
            )}
          </>
        }
      />
      <FreeTierBanner />

      <StatGrid>
        <StatTile value={streak.current} label={`Current ${unit} streak`} tone={streak.current > 0 ? "live" : "default"} />
        <StatTile value={streak.best} label={`Best ${unit} streak`} />
        <StatTile value={`${Math.round(hitRate * 100)}%`} label="Goal hit rate, 8 weeks" tone="accent" />
        <StatTile value={`${met} of ${weeks.length}`} label="Weeks on goal" />
      </StatGrid>

      <div className="grid gap-x-6 lg:grid-cols-2">
        <div>
          <Panel title="Last 30 days">
            <Heatmap
              days={map.days}
              label={`${habit.name}, last 30 days`}
              legend="Darker means closer to the daily target."
              describe={(d) =>
                habit.kind === "numeric"
                  ? `${shortDay(d.date)}: ${d.value ?? "0"} of ${target} ${habit.unit}`
                  : `${shortDay(d.date)}: ${d.done ? "done" : "not done"}`
              }
            />
          </Panel>
          <Panel title="Goal hit rate">
            <DataList caption={`${habit.name}, last 8 weeks`} columns={columns} rows={[...weeks].reverse()} rowKey={(w) => w.week} />
          </Panel>
        </div>
        <Panel title="Edit the last 7 days">
          {archived ? (
            <p className="rounded-card bg-background px-4 py-6 text-center text-sm text-muted">
              This habit is archived. Restore it on the <Link href="/habits" className="font-semibold text-accent hover:underline">Habits page</Link> to change its check-ins.
            </p>
          ) : (
            <>
              <p className="mb-3 text-sm text-muted">
                You can check in for today and up to 7 days back, never before {shortDay(createdOn)}, when you created this habit.
              </p>
              <RecentDays
                habit={{ id: habit.id, name: habit.name, kind: habit.kind, unit: habit.unit, dailyTarget: habit.dailyTarget }}
                days={editable}
              />
              {skipped > 0 && <p className="mt-3 text-sm text-muted">{plural(skipped, "earlier day")} hidden: before this habit existed.</p>}
            </>
          )}
        </Panel>
      </div>
    </>
  );
}
