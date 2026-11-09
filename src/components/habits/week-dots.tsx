export type DotState = "done" | "partial" | "none" | "future";
export type Dot = { key: string; label: string; state: DotState; today?: boolean };

const fill: Record<DotState, string> = {
  done: "border-live bg-live text-accent-foreground",
  partial: "border-building bg-building-soft text-building",
  none: "border-border-strong bg-surface",
  future: "border-border bg-background",
};

// Done and partly done differ by shape as well as colour: a check mark and a dash.
const glyph: Record<DotState, string> = { done: "✓", partial: "–", none: "", future: "" };
const words: Record<DotState, string> = { done: "done", partial: "partly done", none: "not done", future: "upcoming" };

/** Seven dots, Monday to Sunday. Text is in the accessible name so color is never the only signal. */
export function WeekDots({ dots, label }: { dots: Dot[]; label: string }) {
  return (
    <ol aria-label={label} className="flex items-center gap-2">
      {dots.map((d) => (
        <li key={d.key} className="flex flex-col items-center gap-1">
          <span
            aria-hidden
            className={`flex size-5 items-center justify-center rounded-full border-2 text-[11px] font-bold leading-none ${fill[d.state]} ${d.today ? "ring-2 ring-accent ring-offset-2 ring-offset-surface" : ""}`}
          >
            {glyph[d.state]}
          </span>
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
