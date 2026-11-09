import { desc } from "drizzle-orm";
import type { Metadata } from "next";
import { LoadDemoControl } from "@/components/admin/load-demo-control";
import { type Column, DataList, PageIntro, Panel, StatGrid, StatTile } from "@/components/ui";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { db, schema } from "@/lib/db";
import { adminCounts } from "@/lib/progress";

export const metadata: Metadata = { title: "Admin" };
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const admin = await requireRoleOrRedirect("admin");
  const counts = await adminCounts(admin);
  const users = await db()
    .select({
      id: schema.user.id,
      name: schema.user.name,
      email: schema.user.email,
      role: schema.user.role,
      createdAt: schema.user.createdAt,
    })
    .from(schema.user)
    .orderBy(desc(schema.user.createdAt))
    .limit(100);

  type Row = (typeof users)[number];
  const columns: Column<Row>[] = [
    { key: "name", header: "Name", primary: true, cell: (u) => u.name },
    { key: "email", header: "Email", className: "break-all", cell: (u) => <span className="break-all">{u.email}</span> },
    {
      key: "role",
      header: "Role",
      cell: (u) => (u.role === "admin" ? <span className="inline-flex rounded-md bg-accent-soft px-2 py-0.5 text-sm font-medium text-accent">Admin</span> : "User"),
    },
    {
      key: "joined",
      header: "Joined",
      className: "whitespace-nowrap",
      cell: (u) => u.createdAt.toISOString().slice(0, 10),
    },
  ];

  const usageLabel: Record<string, string> = { push: "Reminders sent today", coach: "Coach summaries written today", demo_load: "Demo loads today" };
  const modes = counts.coachSummariesThisWeek;

  return (
    <>
      <PageIntro
        section="Admin"
        title="Overview"
        description="Counts only. Habit names, check-ins and coach summaries belong to their owners and are never shown here."
      />
      <StatGrid>
        <StatTile value={counts.users} label="Users" tone="accent" />
        <StatTile value={counts.activeHabits} label="Active habits" />
        <StatTile value={counts.checkInsToday} label="Check-ins today (UTC)" />
        <StatTile value={counts.checkInsLast7Days} label="Check-ins, last 7 days" />
        <StatTile value={counts.pushDevices} label="Reminder devices" />
        <StatTile value={counts.remindersSentToday} label="Reminders sent today" />
        <StatTile value={modes.live + modes.demo + modes.skipped + modes.fallback} label="Coach summaries this week" />
        <StatTile value={users.filter((u) => u.role === "admin").length} label="Admins" />
      </StatGrid>

      <div className="grid gap-x-6 lg:grid-cols-2">
        <Panel title="Usage against daily caps">
          <ul className="divide-y divide-border">
            {counts.usage.map((u) => {
              const pct = u.cap ? Math.min(100, Math.round((100 * u.used) / u.cap)) : null;
              return (
                <li key={u.kind} className="space-y-2 py-3 first:pt-0 last:pb-0">
                  <p className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="font-semibold">{usageLabel[u.kind] ?? u.kind}</span>
                    <span className="tabular-nums text-muted">{u.cap ? `${u.used} of ${u.cap}` : `${u.used}, no daily cap`}</span>
                  </p>
                  {pct !== null && (
                    <div role="img" aria-label={`${pct} percent of the daily cap`} className="h-2 overflow-hidden rounded-full bg-idle-soft">
                      <div className={`h-full rounded-full ${pct >= 90 ? "bg-blocked" : pct >= 70 ? "bg-building" : "bg-live"}`} style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Panel>
        <Panel title="Coach summaries this week">
          <dl className="grid grid-cols-2 gap-3">
            {(
              [
                ["Live", modes.live],
                ["Demo", modes.demo],
                ["No check-ins", modes.skipped],
                ["Fallback text", modes.fallback],
              ] as const
            ).map(([label, n]) => (
              <div key={label} className="rounded-card border border-border bg-background px-3 py-2">
                <dt className="text-sm text-muted">{label}</dt>
                <dd className="font-display text-2xl font-semibold tabular-nums">{n}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>

      <Panel title="Demo workspace">
        <LoadDemoControl />
      </Panel>

      <Panel title="All users" count={users.length}>
        <DataList caption="Users" rows={users} rowKey={(u) => u.id} columns={columns} empty="No users yet." />
      </Panel>
    </>
  );
}
