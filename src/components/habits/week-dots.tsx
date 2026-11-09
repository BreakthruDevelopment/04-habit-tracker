export type DotState = "done" | "partial" | "none" | "future";
export type Dot = { key: string; label: string; state: DotState; today?: boolean };

const fill: Record<DotState, string> = {
  done: "border-live bg-live",
  partial: "border-building bg-building-soft",
  none: "border-border-strong bg-surface",
  future: "border-border bg-background",
};

const words: Record<DotState, string> = { done: "done", partial: "partly done", none: "not done", future: "upcoming" };

/** Seven dots, Monday to Sunday. Text is in the accessible name so color is never the only signal. */
export function WeekDots({ dots, label }: { dots: Dot[]; label: string }) {
  return (
    <ol aria-label={label} className="flex items-center gap-2">
      {dots.map((d) => (
        <li key={d.key} className="flex flex-col items-center gap-1">
          <span
            className={`size-4 rounded-full border-2 ${fill[d.state]} ${d.today ? "ring-2 ring-accent ring-offset-2 ring-offset-surface" : ""}`}
          />
          <span aria-hidden className="text-xs text-muted">
            {d.label.slice(0, 1)}
          </span>
          <span className="sr-only">
            {d.label}: {words[d.state]}
            {d.today ? " (today)" : ""}
          </span>
        </li>
      ))}
    </ol>
  );
}
