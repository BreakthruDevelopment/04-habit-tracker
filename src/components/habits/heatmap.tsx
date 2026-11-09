import type { HeatmapDay } from "@/lib/progress";
import { shortDay } from "@/lib/format";
import { isoWeekday } from "@/lib/time";

const tones = ["bg-background", "bg-live/25", "bg-live/50", "bg-live/75", "bg-live"] as const;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/**
 * The last 30 days as a calendar: 7 rows (Monday to Sunday) and one column per ISO week, so 5 or 6 columns.
 * Days before the first and after the last are empty padding cells. 36 px token-coloured cells: 6 columns plus
 * the weekday labels fit at 375 px. No chart library. `describe` gives the cell text ("Nov 3: 3 of 5"); the
 * component prefixes the weekday and adds ", today".
 */
export function Heatmap({
  days,
  label,
  describe,
  legend,
  scale = "intensity",
}: {
  days: HeatmapDay[];
  label: string;
  describe: (day: HeatmapDay) => string;
  legend: string;
  /** `binary` for yes/no habits: two swatches, Not done and Done. */
  scale?: "intensity" | "binary";
}) {
  const first = days[0];
  const last = days[days.length - 1];
  const lead = first ? isoWeekday(first.date) - 1 : 0; // Monday is 0
  const columns = Math.ceil((lead + days.length) / 7);
  const trail = columns * 7 - lead - days.length;
  const cells: (HeatmapDay | null)[] = [...Array<null>(lead).fill(null), ...days, ...Array<null>(trail).fill(null)];
  const swatches = scale === "binary" ? [tones[0], tones[4]] : tones;
  return (
    <figure className="space-y-3">
      <div className="flex gap-2">
        <div aria-hidden className="grid grid-rows-[repeat(7,2.25rem)] gap-1 text-xs text-muted">
          {DAYS.map((d) => (
            <span key={d} className="flex items-center">
              {d}
            </span>
          ))}
        </div>
        <div role="group" aria-label={label} className="grid grid-flow-col grid-rows-[repeat(7,2.25rem)] gap-1">
          {cells.map((d, i) => {
            if (!d) return <div key={`pad-${i}`} aria-hidden className="size-9" />;
            const isToday = last !== undefined && d.date === last.date;
            const text = `${DAYS[isoWeekday(d.date) - 1]}, ${describe(d)}${isToday ? ", today" : ""}`;
            return (
              <div
                key={d.date}
                role="img"
                aria-label={text}
                title={text}
                className={`size-9 rounded-md border border-border ${tones[d.intensity]} ${isToday ? "ring-2 ring-accent ring-offset-1 ring-offset-surface" : ""}`}
              />
            );
          })}
        </div>
      </div>
      <figcaption className="space-y-2 text-sm text-muted">
        {first && last && (
          <p>
            {shortDay(first.date)} to {shortDay(last.date)}. Rows are Monday to Sunday; each column is a week.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <span>{scale === "binary" ? "Not done" : "Less"}</span>
          <span aria-hidden className="flex gap-1">
            {swatches.map((t) => (
              <span key={t} className={`size-4 rounded border border-border ${t}`} />
            ))}
          </span>
          <span>{scale === "binary" ? "Done" : "More"}</span>
        </div>
        <p>{legend}</p>
      </figcaption>
    </figure>
  );
}
