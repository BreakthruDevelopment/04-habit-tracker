/** Date and number helpers shared by server and client components. Dates are `YYYY-MM-DD` and formatted in UTC so both sides agree. */

const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const longDay = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });

const at = (date: string) => new Date(`${date}T00:00:00Z`);

/** "Nov 3" */
export const shortDay = (date: string) => day.format(at(date));
/** "Sunday, November 8" */
export const fullDay = (date: string) => longDay.format(at(date));
/** "Mon" */
export const weekdayName = (date: string) => weekday.format(at(date));

/** Plural helper: `plural(1, "day")` is "1 day", `plural(2, "day")` is "2 days". */
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Cents as an integer, so comparisons against a target don't suffer from floating point. */
export const cents = (v: string) => Math.round(Number(v) * 100);

/** The same rule the server applies: a number with at most 2 decimals, above 0 and at most 100,000. */
export function parseAmount(text: string): string | null {
  const t = text.trim();
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  return n > 0 && n <= 100_000 ? t : null;
}

const STEPS = [0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

/** A sensible +/- step for a daily target: about a tenth of it, from a short list (8 glasses: 1; 8,000 steps: 1,000). */
export function stepFor(target: number): number {
  const raw = target / 10;
  return STEPS.find((s) => s >= raw) ?? STEPS[STEPS.length - 1];
}

/** Add or subtract with 2-decimal rounding, returned as a string without trailing zeros. */
export function addAmount(a: number, b: number): string {
  return String(Math.round((a + b) * 100) / 100);
}
