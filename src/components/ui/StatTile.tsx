import type { ReactNode } from "react";

const tones = {
  default: "text-foreground",
  accent: "text-accent",
  live: "text-live",
  building: "text-building",
  blocked: "text-blocked",
} as const;

export function StatTile({
  value,
  label,
  tone = "default",
}: {
  value: ReactNode;
  label: string;
  tone?: keyof typeof tones;
}) {
  return (
    <div className="rounded-card border border-border bg-surface px-5 py-4">
      <p className={`font-display text-4xl font-semibold leading-none ${tones[tone]}`}>{value}</p>
      <p className="mt-2 text-base">{label}</p>
    </div>
  );
}

/** Tiles stack at 375px, two across on tablets, four across on desktop. */
export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{children}</div>;
}
