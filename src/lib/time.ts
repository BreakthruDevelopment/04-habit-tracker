/**
 * Dates and weeks, in one place. "Today" is always computed on the server from the user's
 * IANA zone, never trusted from the client. Dates travel as `YYYY-MM-DD` strings (the shape
 * Postgres `date` columns use here) and all calendar maths is done on UTC epoch days, so it
 * can't be skewed by the server's own zone or DST.
 *
 * Weeks are ISO weeks: they start on Monday, and a week belongs to the year that holds its
 * Thursday (the ISO week-year). So 2027-01-01 is in `2026-W53`, and 2024-12-30 is `2025-W01`.
 */
import { BadRequestError } from "@/lib/errors";

const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEK_RE = /^(\d{4})-W(\d{2})$/;

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** Days since 1970-01-01 for a valid `YYYY-MM-DD`, or null. Rejects 2026-02-30 and the like. */
function toEpochDay(date: string): number | null {
  const m = DATE_RE.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1) return null;
  const ms = Date.UTC(y, mo - 1, d);
  // Date.UTC maps years 0-99 to 1900-1999; the year check above and this round trip keep us honest.
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return ms / DAY_MS;
}

function fromEpochDay(day: number): string {
  const d = new Date(day * DAY_MS);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function isValidDate(date: unknown): date is string {
  return typeof date === "string" && toEpochDay(date) !== null;
}

function epochDay(date: string): number {
  const day = toEpochDay(date);
  if (day === null) throw new RangeError(`Invalid date: ${date}`);
  return day;
}

export function addDays(date: string, days: number): string {
  return fromEpochDay(epochDay(date) + days);
}

/** Whole days from `a` to `b` (positive when `b` is later). */
export function daysBetween(a: string, b: string): number {
  return epochDay(b) - epochDay(a);
}

/** 1 (Monday) to 7 (Sunday). */
export function isoWeekday(date: string): number {
  const day = epochDay(date);
  // 1970-01-01 was a Thursday.
  return ((((day + 3) % 7) + 7) % 7) + 1;
}

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

/**
 * Older ICU data (Node 22 among them) lists, and the browser may report, pre-rename zone names that the
 * database's tz files don't have, and leaves out their modern names (Node 22 has no Asia/Kolkata).
 * We store the modern name, which Postgres knows, and accept the old one as input.
 */
const LEGACY_ZONES: Record<string, string> = {
  "Africa/Asmera": "Africa/Asmara",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Catamarca": "America/Argentina/Catamarca",
  "America/Cordoba": "America/Argentina/Cordoba",
  "America/Godthab": "America/Nuuk",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Jujuy": "America/Argentina/Jujuy",
  "America/Louisville": "America/Kentucky/Louisville",
  "America/Mendoza": "America/Argentina/Mendoza",
  "America/Montreal": "America/Toronto",
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Istanbul": "Europe/Istanbul",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Etc/UTC": "UTC",
  "Europe/Nicosia": "Asia/Nicosia",
  "Europe/Kiev": "Europe/Kyiv",
  "Pacific/Enderbury": "Pacific/Kanton",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Truk": "Pacific/Chuuk",
};

/** Every zone a user may pick, by its modern name, sorted. Includes UTC. */
export const TIME_ZONES: readonly string[] = (() => {
  const names = new Set<string>(["UTC"]);
  for (const z of Intl.supportedValuesOf("timeZone")) names.add(LEGACY_ZONES[z] ?? z);
  // A newer or older ICU may list one spelling only; make sure both spellings' modern name is present.
  for (const modern of Object.values(LEGACY_ZONES)) names.add(modern);
  return [...names].filter(runtimeKnowsZone).sort();
})();

const ZONE_SET = new Set(TIME_ZONES);

function runtimeKnowsZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The name to store for `tz` (exact case, modern spelling), or null if it isn't a zone we accept. */
export function normalizeTimeZone(tz: unknown): string | null {
  if (typeof tz !== "string") return null;
  const name = LEGACY_ZONES[tz] ?? tz;
  return ZONE_SET.has(name) ? name : null;
}

export function isValidTimeZone(tz: unknown): tz is string {
  return normalizeTimeZone(tz) !== null;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The calendar date it is right now in `tz`: `YYYY-MM-DD`. `now` is a parameter so tests can pin it. */
export function localToday(tz: string, now: Date): string {
  const zone = normalizeTimeZone(tz);
  if (!zone) throw new RangeError(`Unknown time zone: ${String(tz)}`);
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatters.set(zone, f);
  }
  const parts: Record<string, string> = {};
  for (const p of f.formatToParts(now)) parts[p.type] = p.value;
  return `${pad(Number(parts.year), 4)}-${parts.month}-${parts.day}`;
}

/**
 * `localToday` for a zone read back from storage: never throws. A stored zone the runtime doesn't
 * recognise (a row from an older tz database, hand-edited data) counts as UTC instead of failing the page.
 */
export function localTodayFor(storedZone: string | null | undefined, now: Date): string {
  return localToday(normalizeTimeZone(storedZone) ?? "UTC", now);
}

// ---------------------------------------------------------------------------
// ISO weeks
// ---------------------------------------------------------------------------

/** 2001-01-01 was a Monday: the origin of the continuous week index (matches the SQL in progress.ts). */
const WEEK_INDEX_ORIGIN = epochDay("2001-01-01");

function mondayEpochDay(day: number): number {
  return day - (((((day + 3) % 7) + 7) % 7));
}

/** Monday of the week holding `date`. */
export function weekStart(date: string): string {
  return fromEpochDay(mondayEpochDay(epochDay(date)));
}

/** Monday and Sunday of the week holding `date`. */
export function weekBounds(date: string): { monday: string; sunday: string } {
  const monday = mondayEpochDay(epochDay(date));
  return { monday: fromEpochDay(monday), sunday: fromEpochDay(monday + 6) };
}

/**
 * A number that goes up by exactly 1 each week, across year ends too (so consecutive weeks have
 * consecutive indexes). Never key weeks on the week number alone: it resets each year.
 */
export function weekIndex(date: string): number {
  return (mondayEpochDay(epochDay(date)) - WEEK_INDEX_ORIGIN) / 7;
}

/** The ISO week label, `YYYY-Www`, using the ISO week-year (2027-01-01 is `2026-W53`). */
export function isoWeek(date: string): string {
  const monday = mondayEpochDay(epochDay(date));
  const thursday = monday + 3;
  const year = new Date(thursday * DAY_MS).getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1) / DAY_MS;
  const week = Math.floor((thursday - jan1) / 7) + 1;
  return `${pad(year, 4)}-W${pad(week)}`;
}

/** 52 or 53. A year has 53 ISO weeks when 1 January is a Thursday, or a Wednesday in a leap year. */
export function isoWeeksInYear(year: number): number {
  const jan1Weekday = isoWeekday(`${pad(year, 4)}-01-01`);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return jan1Weekday === 4 || (leap && jan1Weekday === 3) ? 53 : 52;
}

/** Whether `week` is a `YYYY-Www` label for a week that exists. */
export function isValidIsoWeek(week: unknown): week is string {
  if (typeof week !== "string") return false;
  const m = WEEK_RE.exec(week);
  if (!m) return false;
  const year = Number(m[1]);
  const n = Number(m[2]);
  return year >= 1000 && n >= 1 && n <= isoWeeksInYear(year);
}

/**
 * The Monday of an ISO week label. Throws a 400 for anything that isn't a real week
 * (`2027-W53` and `2026-W54` don't exist), so routes can let it reach `errorResponse`.
 */
export function parseIsoWeek(week: string): string {
  if (!isValidIsoWeek(week)) throw new BadRequestError("Invalid week. Use YYYY-Www, for example 2026-W45.");
  const year = Number(week.slice(0, 4));
  const n = Number(week.slice(6));
  // Week 1 is the week holding 4 January.
  const jan4 = Date.UTC(year, 0, 4) / DAY_MS;
  return fromEpochDay(mondayEpochDay(jan4) + (n - 1) * 7);
}

/** The week before or after `week` (a label), across year ends. */
export function shiftIsoWeek(week: string, weeks: number): string {
  return isoWeek(addDays(parseIsoWeek(week), weeks * 7));
}
