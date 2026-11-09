"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DemoBadge, Panel, StatusBadge, buttonOutlineAccent, buttonPrimary } from "@/components/ui";
import { getJson } from "@/lib/client-api";
import type { CoachSummaryView, CoachView } from "@/lib/coach";

type Notice = { kind: "ok" | "error"; text: string };

const stamp = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const RETRY_MS = 2500;
const MAX_RETRIES = 4;

function ModeBadge({ mode }: { mode: CoachSummaryView["mode"] }) {
  if (mode === "demo") return <DemoBadge label="Demo summary" />;
  if (mode === "live") return <StatusBadge status="live" label="Live AI" />;
  if (mode === "fallback") return <StatusBadge status="degraded" label="Built from your numbers" />;
  return <StatusBadge status="not-started" label="No AI used" />;
}

function Items({ title, items }: { title: string; items: CoachSummaryView["data"]["wins"] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h4 className="font-semibold">{title}</h4>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        {items.map((it, i) => (
          <li key={i} className="break-words">
            {it.habitName && <strong>{it.habitName}: </strong>}
            {it.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The numbers the summary was written from, beside it. Names are the owner's own, taken from their live habits. */
function StatsBeside({ stats }: { stats: CoachSummaryView["stats"] }) {
  return (
    <div className="space-y-3">
      <h4 className="font-semibold">The numbers behind it</h4>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-card border border-border bg-background px-3 py-2">
          <dt className="text-muted">Completion</dt>
          <dd className="font-display text-2xl font-semibold text-accent">{stats.totals.completionPct}%</dd>
        </div>
        <div className="rounded-card border border-border bg-background px-3 py-2">
          <dt className="text-muted">Habits on goal</dt>
          <dd className="font-display text-2xl font-semibold">
            {stats.totals.habitsOnGoal} of {stats.totals.habits}
          </dd>
        </div>
        <div className="col-span-2 rounded-card border border-border bg-background px-3 py-2">
          <dt className="text-muted">Check-ins done</dt>
          <dd className="font-display text-2xl font-semibold">{stats.totals.doneCheckIns}</dd>
        </div>
      </dl>
      {stats.habits.length > 0 && (
        <ul className="divide-y divide-border text-sm">
          {stats.habits.map((h) => (
            <li key={h.habitId} className="flex items-baseline justify-between gap-3 py-2">
              <span className="min-w-0 break-words">{h.name ?? "A removed habit"}</span>
              <span className="shrink-0 tabular-nums text-muted">
                {h.doneDays} of {h.goal} days
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The weekly coach on /progress. Reading never calls the model; only the button does. Always labelled "AI summary,
 * not advice". Handles the guardrail caps (429), a generation already in flight (409) and a provider failure (502).
 */
export function CoachPanel({ week }: { week: string }) {
  const [view, setView] = useState<CoachView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    setView(null);
    const res = await getJson(`/api/coach?week=${encodeURIComponent(week)}`);
    if (!alive.current) return;
    setLoading(false);
    if (res.ok) setView(res.data as CoachView);
    else setLoadError(res.status === 400 ? "The coach covers this week and last week only." : res.message);
  }, [week]);

  useEffect(() => {
    // Loads from the server when the panel mounts or the week changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  /** After a 409 another request is writing the summary: wait for it with reads, never a second POST. */
  async function waitForSummary(): Promise<boolean> {
    const before = view?.summary?.generatedAt ?? null;
    for (let i = 0; i < MAX_RETRIES; i++) {
      await new Promise((r) => setTimeout(r, RETRY_MS));
      if (!alive.current) return true;
      const got = await getJson(`/api/coach?week=${encodeURIComponent(week)}`);
      if (got.ok) {
        const v = got.data as CoachView;
        if (v.summary && v.summary.generatedAt !== before) {
          setView(v);
          return true;
        }
      }
    }
    return false;
  }

  async function generate() {
    setBusy(true);
    setNotice(null);
    const res = await postCoach(week);
    if (!alive.current) return;
    if (res.ok) {
      const r = res.body as CoachView & { cached?: boolean };
      setView({ week: r.week, summary: r.summary, refreshesLeft: r.refreshesLeft });
      setNotice({ kind: "ok", text: r.cached ? "Your summary is up to date." : "Summary ready." });
    } else if (res.status === 409) {
      setNotice({ kind: "ok", text: "Your summary is being written. One moment…" });
      const done = await waitForSummary();
      if (!alive.current) return;
      setNotice(done ? { kind: "ok", text: "Summary ready." } : { kind: "error", text: "Your summary is still being written. Try again in a moment." });
    } else if (res.status === 429) {
      // The route sends the stored summary along with the reason, so keep showing it.
      const b = res.body as Partial<CoachView>;
      if (b.summary) setView({ week: b.week ?? week, summary: b.summary, refreshesLeft: b.refreshesLeft ?? 0 });
      else if (b.refreshesLeft !== undefined) setView((v) => (v ? { ...v, refreshesLeft: b.refreshesLeft ?? 0 } : v));
      setNotice({ kind: "error", text: res.message });
    } else if (res.status === 502) {
      setNotice({ kind: "error", text: "The coach couldn't answer right now. Nothing was used, so you can try again." });
    } else {
      setNotice({ kind: "error", text: res.message });
    }
    setBusy(false);
  }

  const summary = view?.summary ?? null;
  const left = view?.refreshesLeft ?? 0;
  const button = summary ? `Refresh (${left} left)` : "Generate summary";
  const unavailable = Boolean(loadError) || loading;

  return (
    <Panel
      title="Weekly coach"
      action={
        <p className="flex flex-wrap items-center gap-2 text-sm">
          {summary && <ModeBadge mode={summary.mode} />}
          <span className="font-medium text-muted">AI summary, not advice</span>
        </p>
      }
    >
      <div aria-busy={loading || busy} className="space-y-4">
        {loading && <p className="text-muted">Loading your summary…</p>}

        {loadError && (
          <div className="space-y-3">
            <p role="alert" className="break-words text-sm font-medium text-danger">
              {loadError}
            </p>
            {!loadError.startsWith("The coach covers") && (
              <button type="button" className={buttonOutlineAccent} onClick={() => void load()}>
                Try again
              </button>
            )}
          </div>
        )}

        {!unavailable && !summary && (
          <div className="space-y-3 rounded-card bg-background px-4 py-6">
            <p className="font-display text-xl font-semibold">No summary for this week yet</p>
            <p className="text-muted">The coach writes a short, encouraging recap from your numbers. It never gives health advice.</p>
          </div>
        )}

        {summary && (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
            <div className="min-w-0 space-y-4">
              <div>
                <h3 className="break-words font-display text-2xl font-semibold">{summary.data.headline}</h3>
                <p className="text-sm text-muted">Written {stamp.format(new Date(summary.generatedAt))}</p>
              </div>
              <p className="break-words">{summary.data.summary}</p>
              <Items title="Wins" items={summary.data.wins} />
              <Items title="Worth a look" items={summary.data.focus} />
              <p className="break-words rounded-card border border-border bg-accent-soft px-3 py-2">
                <strong>Next step: </strong>
                {summary.data.nextStep}
              </p>
            </div>
            <StatsBeside stats={summary.stats} />
          </div>
        )}

        {!unavailable && (
          <div className="space-y-2">
            <button
              type="button"
              className={`${summary ? buttonOutlineAccent : buttonPrimary} w-full sm:w-auto`}
              disabled={busy || (summary !== null && left === 0)}
              onClick={() => void generate()}
            >
              {busy ? "Writing…" : button}
            </button>
            {summary && left === 0 && <p className="text-sm text-muted">This week&apos;s summary has been refreshed twice; it updates next week.</p>}
          </div>
        )}

        <p role={notice?.kind === "error" ? "alert" : "status"} className={`min-w-0 break-words text-sm ${notice?.kind === "error" ? "font-medium text-danger" : ""}`}>
          {notice?.text}
        </p>
      </div>
    </Panel>
  );
}

type CoachPost = { ok: boolean; status: number; message: string; body: unknown };

/** POST /api/coach with a timeout. Keeps the body, because a 429 carries the stored summary with it. */
async function postCoach(week: string): Promise<CoachPost> {
  try {
    const res = await fetch("/api/coach", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ week }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: res.ok, status: res.status, message: body.error || "Something went wrong. Try again.", body };
  } catch (err) {
    const timedOut = err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError");
    return { ok: false, status: timedOut ? -1 : 0, message: timedOut ? "That took too long. Try again." : "Couldn't reach the server. Check your connection and try again.", body: {} };
  }
}
