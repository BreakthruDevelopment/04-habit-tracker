"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { type Column, DataList, Panel, buttonDanger, buttonSecondary } from "@/components/ui";
import { sendJson } from "@/lib/client-api";
import { HabitForm, type HabitFormValues } from "./habit-form";

export type ManagedHabit = HabitFormValues;

const iconButton =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-card border border-border bg-surface text-lg font-semibold text-foreground hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-60";

function describe(h: ManagedHabit): string {
  const goal = h.weeklyGoal === 7 ? "every day" : `${h.weeklyGoal} ${h.weeklyGoal === 1 ? "day" : "days"} a week`;
  return h.kind === "numeric" ? `${h.dailyTarget} ${h.unit} a day, ${goal}` : `Yes or no, ${goal}`;
}

export function HabitsManager({ active, archived }: { active: ManagedHabit[]; archived: ManagedHabit[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  async function run(label: string, call: () => ReturnType<typeof sendJson>) {
    setBusy(true);
    setError("");
    setNotice("");
    const res = await call();
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return false;
    }
    setNotice(label);
    router.refresh();
    return true;
  }

  const move = (index: number, by: -1 | 1) => {
    const ids = active.map((h) => h.id);
    const [id] = ids.splice(index, 1);
    ids.splice(index + by, 0, id);
    return run(`Moved ${active[index].name} ${by < 0 ? "up" : "down"}.`, () => sendJson("POST", "/api/habits/reorder", { ids }));
  };
  const setArchived = (h: ManagedHabit, archivedFlag: boolean) =>
    run(archivedFlag ? `Archived ${h.name}.` : `Restored ${h.name}.`, () =>
      sendJson("PATCH", `/api/habits/${h.id}`, { updatedAt: h.updatedAt, archived: archivedFlag }),
    );
  async function remove(h: ManagedHabit) {
    const ok = await run(`Deleted ${h.name}.`, () => sendJson("DELETE", `/api/habits/${h.id}`));
    if (ok) setConfirming(null);
  }

  function columns(isArchived: boolean): Column<ManagedHabit>[] {
    return [
      {
        key: "name",
        header: "Habit",
        primary: true,
        cell: (h) => (
          <Link href={`/habits/${h.id}`} className="inline-flex min-h-11 items-center font-semibold text-accent hover:underline">
            {h.name}
          </Link>
        ),
      },
      { key: "goal", header: "Target", cell: describe },
      {
        key: "actions",
        header: "Actions",
        srOnlyHeader: true,
        hideLabel: true,
        className: "sm:text-right",
        cell: (h) => {
          const index = active.findIndex((a) => a.id === h.id);
          if (confirming === h.id) {
            return (
              <div className="space-y-3 text-left">
                <p className="break-words text-sm">Delete {h.name} and all its check-ins? This can&apos;t be undone.</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={busy} onClick={() => void remove(h)} className={buttonDanger}>
                    {busy ? "Deleting…" : "Yes, delete"}
                  </button>
                  <button type="button" disabled={busy} onClick={() => setConfirming(null)} className={buttonSecondary}>
                    Cancel
                  </button>
                </div>
              </div>
            );
          }
          return (
            <div className="flex flex-wrap gap-2 sm:justify-end">
              {!isArchived && (
                <>
                  <button type="button" aria-label={`Move ${h.name} up`} disabled={busy || index <= 0} onClick={() => void move(index, -1)} className={iconButton}>
                    <span aria-hidden>↑</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${h.name} down`}
                    disabled={busy || index < 0 || index >= active.length - 1}
                    onClick={() => void move(index, 1)}
                    className={iconButton}
                  >
                    <span aria-hidden>↓</span>
                  </button>
                  <button type="button" disabled={busy} onClick={() => { setEditing(h.id); setNotice(""); }} className={buttonSecondary} aria-label={`Edit ${h.name}`}>
                    Edit
                  </button>
                </>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => void setArchived(h, !isArchived)}
                className={buttonSecondary}
                aria-label={`${isArchived ? "Restore" : "Archive"} ${h.name}`}
              >
                {isArchived ? "Restore" : "Archive"}
              </button>
              <button type="button" disabled={busy} onClick={() => setConfirming(h.id)} className={buttonDanger} aria-label={`Delete ${h.name}`}>
                Delete
              </button>
            </div>
          );
        },
      },
    ];
  }

  const editingHabit = editing ? active.find((h) => h.id === editing) : undefined;

  return (
    <>
      <div aria-live="polite" className="mb-4 empty:hidden">
        {notice && <p role="status" className="text-sm font-medium text-success">{notice}</p>}
        {error && (
          <p role="alert" className="break-words rounded-card border border-border bg-blocked-soft px-3 py-2 text-sm font-medium text-danger">
            {error}
          </p>
        )}
      </div>

      {editingHabit ? (
        <Panel title={`Edit ${editingHabit.name}`}>
          <HabitForm
            key={`${editingHabit.id}:${editingHabit.updatedAt}`}
            habit={editingHabit}
            onCancel={() => setEditing(null)}
            onReload={() => {
              setNotice("Reloaded the latest version of this habit.");
              router.refresh();
            }}
            onDone={(message) => {
              setEditing(null);
              setNotice(message);
              router.refresh();
            }}
          />
        </Panel>
      ) : (
        <Panel title="Add a habit">
          <HabitForm onDone={(message) => { setNotice(message); router.refresh(); }} />
        </Panel>
      )}

      <Panel title="Your habits" count={active.length}>
        <DataList
          caption="Active habits"
          columns={columns(false)}
          rows={active}
          rowKey={(h) => h.id}
          empty="No habits yet. Add your first habit above."
        />
      </Panel>

      {archived.length > 0 && (
        <Panel title="Archived" count={archived.length} collapsible defaultOpen={false} closedLabel="Show archived" openLabel="Hide">
          <DataList caption="Archived habits" columns={columns(true)} rows={archived} rowKey={(h) => h.id} />
        </Panel>
      )}
    </>
  );
}
