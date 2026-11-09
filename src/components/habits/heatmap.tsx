import type { HeatmapDay } from "@/lib/progress";
import { shortDay } from "@/lib/format";

const tones = [
  "bg-background",
  "bg-live/25",
  "bg-live/50",
  "bg-live/75",
  "bg-live",
] as const;

const CELLS = 35; // 7 rows by 5 columns holds the 30 days; the last 5 cells stay empty.

/**
 * 30 days as a 7 x 5 grid of token-coloured cells, filled down each column from the oldest day.
 * 36 px cells on every width, so the grid is 5 x 36 px plus gaps: it fits at 375 px. No chart library.
 * `describe` makes each cell's `aria-label` ("Nov 3: 3 of 5").
 */
export function Heatmap({
  days,
  label,
  describe,
  legend,
}: {
  days: HeatmapDay[];
  label: string;
  describe: (day: HeatmapDay) => string;
  legend: string;
}) {
  const cells = Array.from({ length: CELLS }, (_, i) => days[i] ?? null);
  const first = days[0];
  const last = days[days.length - 1];
  return (
    <figure className="space-y-3">
      <div
        role="group"
        aria-label={label}
        className="grid w-fit grid-flow-col grid-rows-[repeat(7,2.25rem)] gap-1"
      >
        {cells.map((d, i) =>
          d ? (
            <div
              key={d.date}
              role="img"
              aria-label={describe(d)}
              title={describe(d)}
              className={`size-9 rounded-md border border-border ${tones[d.intensity]}`}
            />
          ) : (
            <div key={`pad-${i}`} aria-hidden className="size-9" />
          ),
        )}
      </div>
      <figcaption className="space-y-2 text-sm text-muted">
        {first && last && (
          <p>
            {shortDay(first.date)} to {shortDay(last.date)}, oldest day first, filling each column from the top.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>Less</span>
          <span aria-hidden className="flex gap-1">
            {tones.map((t) => (
              <span key={t} className={`size-4 rounded border border-border ${t}`} />
            ))}
          </span>
          <span>More</span>
          <span className="basis-full sm:basis-auto sm:before:content-['·'] sm:before:mr-2">{legend}</span>
        </div>
      </figcaption>
    </figure>
  );
}
