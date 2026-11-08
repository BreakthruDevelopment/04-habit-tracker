export type Status =
  | "live"
  | "healthy"
  | "building"
  | "degraded"
  | "blocked"
  | "down"
  | "failed"
  | "passed"
  | "not-started";

const config: Record<Status, { label: string; className: string; dot: string }> = {
  live: { label: "Live", className: "bg-live-soft text-live", dot: "bg-live" },
  healthy: { label: "Healthy", className: "bg-live-soft text-live", dot: "bg-live" },
  passed: { label: "Passed", className: "bg-live-soft text-live", dot: "bg-live" },
  building: { label: "Building", className: "bg-building-soft text-building", dot: "bg-building" },
  degraded: { label: "Degraded", className: "bg-building-soft text-building", dot: "bg-building" },
  blocked: { label: "Blocked", className: "bg-blocked-soft text-blocked", dot: "bg-blocked" },
  down: { label: "Down", className: "bg-blocked-soft text-blocked", dot: "bg-blocked" },
  failed: { label: "Failed", className: "bg-blocked-soft text-blocked", dot: "bg-blocked" },
  // Not started is neutral on purpose: it is a plan, not a problem.
  "not-started": { label: "Not started", className: "bg-idle-soft text-idle", dot: "bg-idle" },
};

/** Status and health label. Always shows text, so color is never the only signal. */
export function StatusBadge({ status, label }: { status: Status; label?: string }) {
  const c = config[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-sm font-medium ${c.className}`}
    >
      <span aria-hidden className={`size-2 rounded-full ${c.dot}`} />
      {label ?? c.label}
    </span>
  );
}
