/** Marks seeded or demo-mode content. A label, not a button. */
export function DemoBadge({ label = "Demo data" }: { label?: string }) {
  return (
    <span className="inline-block whitespace-nowrap rounded-md border border-border bg-background px-2 py-0.5 text-xs font-medium text-muted">
      {label}
    </span>
  );
}
