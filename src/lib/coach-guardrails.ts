/**
 * Guardrails for the weekly coach, applied in code after the schema has accepted the model's output.
 * Pure functions: no database, no logging, no model. The coach never gives health advice, never invents numbers
 * and never shames; whatever fails these checks is replaced by neutral text built from the user's own stats.
 */
import type { CoachInput, CoachOutput } from "@/lib/weekly-coach";

export type GuardCode = "medical_language" | "invented_number" | "shame_language" | "unknown_habit" | "empty_field";

// ---------------------------------------------------------------------------
// Word lists (matched on lower-cased text with accents and zero-width characters removed)
// ---------------------------------------------------------------------------

/**
 * Health and medical language. Stems on purpose: `medic` covers medication, medical and medicine. Plain "treat" is not
 * listed ("treat yourself" is harmless); "sleep" is not either, because a habit can be named "Sleep by 11".
 */
export const HEALTH_PATTERNS: readonly RegExp[] = [
  /\bdiagnos/,
  /\bsymptom/,
  /\bdisease/,
  /\bdisorder/,
  /\bmedic/,
  /\bdos(?:e|es|ed|ing|age|ages)\b/,
  /\bprescri/,
  /\btherap/,
  /\btreatment/,
  /\bcures?[ds]?\b/,
  /\bdoctor/,
  /\bphysician/,
  /\bclinic/,
  /\bcalori/,
  /\bweight/,
  /\bbmi\b/,
  /\bdepress/,
  /\banxi/,
  /\binjur/,
  /\bnutrition/,
  /\bdiet(?:s|ary|ing)?\b/,
  /\bsupplement/,
  /\bmental health/,
  /\bhealth\b/,
  /\bpain(?:s|ful)?\b/,
  /\bsurg(?:ery|ical)/,
  /\bpregnan/,
  /\bdiabet/,
  /\bcancer/,
  /\bblood\b/,
  /\bheart\b/,
  /\bcholesterol/,
  /\binsomnia/,
  /\bsuicid/,
  /\bself[- ]?harm/,
  /\bhormon/,
  /\bantibiotic/,
  /\bpills?\b/,
  /\bdetox/,
  /\bfasting\b/,
  /\bmetabolism/,
  /\bimmune/,
  /\bhospital/,
  /\billness/,
  /\bmilligram/,
  /\bmg\b/,
  /\btrauma/,
  /\bpanic/,
];

export const SHAME_PATTERNS: readonly RegExp[] = [
  /\blazy/,
  /\blaziness/,
  /\bfail(?:s|ed|ing|ure|ures)?\b/,
  /\bdisappoint/,
  /\bpathetic/,
  /\bguilt/,
  /\bshame/,
  /\bslack(?:er|ed|ing)?\b/,
  /\bexcuses?\b/,
  /\bworthless/,
  /\bgave up\b/,
  /\bgive up\b/,
  /\bquitter/,
  /\bterrible/,
  /\bunderperform/,
  /\bneglect/,
];

/** Lower-case, drop accents and invisible characters, so "Méd​ication" can't slip past a stem. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ​-‏⁠﻿]/g, "")
    .toLowerCase();
}

export function hasHealthLanguage(text: string): boolean {
  const t = normalizeForMatch(text);
  return HEALTH_PATTERNS.some((p) => p.test(t));
}

export function hasShameLanguage(text: string): boolean {
  const t = normalizeForMatch(text);
  return SHAME_PATTERNS.some((p) => p.test(t));
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

const NUMBER_WORDS: Record<string, number> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  twice: 2,
  thrice: 3,
};
// "one" is left out: "one step" and "every one of them" are not claims about the stats.
const NUMBER_WORD_RE = new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join("|")})\\b`, "g");

/** Every number in `text`: digit runs (with "1,000" and "2.5" kept whole) and the spelled-out numbers two to ten. */
export function numbersIn(text: string): number[] {
  const t = normalizeForMatch(text).replace(/(\d),(?=\d{3}\b)/g, "$1");
  const out: number[] = [];
  for (const m of t.matchAll(/\d+(?:\.\d+)?/g)) out.push(Number(m[0]));
  for (const m of t.matchAll(NUMBER_WORD_RE)) out.push(NUMBER_WORDS[m[1]]);
  return out;
}

/** The numbers a text may use: everything in the stats block the model saw, plus 7 (days in a week). */
export function allowedNumbers(modelStatsJson: string): Set<number> {
  // Spelled-out words in habit names would otherwise count as numbers; only digits are read from the stats.
  const allowed = new Set<number>([7]);
  for (const m of modelStatsJson.matchAll(/\d+(?:\.\d+)?/g)) allowed.add(Number(m[0]));
  return allowed;
}

export function hasInventedNumber(text: string, allowed: ReadonlySet<number>): boolean {
  return numbersIn(text).some((n) => !allowed.has(n));
}

// ---------------------------------------------------------------------------
// Deterministic text, built only from the stats
// ---------------------------------------------------------------------------

function denominator(input: CoachInput): string {
  return input.isCurrent && input.daysElapsed < 7 ? `${input.daysElapsed} days so far` : "7 days";
}

/** "You checked in on 4 of 7 days." for one habit; `goal` adds the goal when it was reached. */
export function habitWinLine(input: CoachInput, id: string): string {
  const h = input.habits.find((x) => x.id === id);
  if (!h) return "You kept showing up.";
  const base = `You checked in on ${h.doneDays} of ${denominator(input)}`;
  return h.doneDays >= h.goal ? `${base} and reached your goal of ${h.goal}.` : `${base}.`;
}

export function habitFocusLine(input: CoachInput, id: string): string {
  const h = input.habits.find((x) => x.id === id);
  if (!h) return "A small, easy version on a busy day keeps a habit alive.";
  return `Your goal is ${h.goal} ${h.goal === 1 ? "day" : "days"} a week. A small, easy version on a busy day keeps it alive.`;
}

function summaryLine(input: CoachInput): string {
  const t = input.totals;
  const when = input.isCurrent && input.daysElapsed < 7 ? " so far this week" : " this week";
  return `You checked in ${t.doneCheckIns} ${t.doneCheckIns === 1 ? "time" : "times"} across ${t.habits} ${t.habits === 1 ? "habit" : "habits"}${when} and reached your goal on ${t.habitsOnGoal}. Every check-in counts, and every new day is a fresh chance.`;
}

const NEXT_STEP = "Pick one habit and choose a simple time for it next week. Starting small is how streaks begin.";

function ratio(h: CoachInput["habits"][number]): number {
  return h.goal === 0 ? 0 : h.doneDays / h.goal;
}

/**
 * Up to 3 habits that reached their goal (or, if none did, the one with the most check-ins) as wins, and up to 2 of
 * the others with the most room as focus. H-ids only.
 */
export function pickWinsAndFocus(input: CoachInput): { wins: string[]; focus: string[] } {
  const order = input.habits.map((h, i) => ({ h, i }));
  const byRatioDesc = (a: (typeof order)[number], b: (typeof order)[number]) => ratio(b.h) - ratio(a.h) || a.i - b.i;
  let wins = order.filter(({ h }) => h.doneDays > 0 && h.doneDays >= h.goal).sort(byRatioDesc).slice(0, 3);
  if (wins.length === 0) wins = order.filter(({ h }) => h.doneDays > 0).sort(byRatioDesc).slice(0, 1);
  const winIds = new Set(wins.map(({ h }) => h.id));
  const focus = order
    .filter(({ h }) => !winIds.has(h.id) && h.doneDays < h.goal)
    .sort((a, b) => ratio(a.h) - ratio(b.h) || a.i - b.i)
    .slice(0, 2);
  return { wins: wins.map(({ h }) => h.id), focus: focus.map(({ h }) => h.id) };
}

function tierHeadline(pct: number): string {
  if (pct >= 80) return "A strong week of showing up";
  if (pct >= 40) return "A solid week with room to grow";
  return "A fresh start is one check-in away";
}

/** The deterministic summary: used when the model's answer can't be trusted. Passes every guardrail by construction. */
export function fallbackOutput(input: CoachInput): CoachOutput {
  const { wins, focus } = pickWinsAndFocus(input);
  return {
    headline: tierHeadline(input.totals.completionPct),
    summary: summaryLine(input),
    wins: wins.map((habit) => ({ habit, text: habitWinLine(input, habit) })),
    focus: focus.map((habit) => ({ habit, text: habitFocusLine(input, habit) })),
    nextStep: NEXT_STEP,
  };
}

/** A week with no check-ins at all: a fixed, kind fresh-start message. No model is called for it. */
export function skippedOutput(input: Pick<CoachInput, "isCurrent" | "totals">): CoachOutput {
  const none = input.totals.habits === 0;
  return {
    headline: "A fresh start",
    summary: none
      ? "You haven't added any habits yet, and that's a perfectly good place to begin. Add one small habit and check it off to get your first recap."
      : input.isCurrent
        ? "Nothing is checked off yet this week, and that's okay. Every week is a fresh start, and one check-in is all it takes to get going."
        : "No check-ins were logged this week, and that's okay. Every week is a fresh start, and one check-in is all it takes to get going.",
    wins: [],
    focus: [],
    nextStep: none ? "Add one habit you can do in a minute." : NEXT_STEP,
  };
}

// ---------------------------------------------------------------------------
// The guardrail pass
// ---------------------------------------------------------------------------

export type GuardResult = { data: CoachOutput; codes: GuardCode[]; fallback: boolean };

const clip = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…");

/**
 * Check every field of an accepted answer. Rules, as the spec has them:
 * - an H-id that isn't in the input is dropped;
 * - health language in `headline` or `summary` turns the whole answer into the deterministic fallback; anywhere
 *   else the field is replaced by neutral text from the stats;
 * - a number that isn't in the stats, or a shame word, replaces the field the same way.
 * `allowed` comes from `allowedNumbers()` over the stats block the model saw.
 */
export function applyGuardrails(raw: CoachOutput, input: CoachInput, allowed: ReadonlySet<number>): GuardResult {
  const codes = new Set<GuardCode>();
  const known = new Set(input.habits.map((h) => h.id));
  const neutral = fallbackOutput(input);

  const verdict = (text: string): GuardCode | null => {
    if (hasHealthLanguage(text)) return "medical_language";
    if (hasShameLanguage(text)) return "shame_language";
    if (hasInventedNumber(text, allowed)) return "invented_number";
    return null;
  };

  // Headline and summary first: health language there means the answer as a whole can't be trusted.
  if (hasHealthLanguage(raw.headline) || hasHealthLanguage(raw.summary)) {
    return { data: neutral, codes: ["medical_language"], fallback: true };
  }

  const field = (text: string, replacement: string): string => {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) {
      codes.add("empty_field");
      return replacement;
    }
    const code = verdict(clean);
    if (code) {
      codes.add(code);
      return replacement;
    }
    return clean;
  };

  const items = (list: CoachOutput["wins"], neutralLine: (id: string) => string) =>
    list.flatMap((item) => {
      if (!known.has(item.habit)) {
        codes.add("unknown_habit");
        return [];
      }
      return [{ habit: item.habit, text: field(item.text, neutralLine(item.habit)) }];
    });

  const data: CoachOutput = {
    headline: clip(field(raw.headline, neutral.headline), 100),
    summary: clip(field(raw.summary, neutral.summary), 600),
    wins: items(raw.wins, (id) => habitWinLine(input, id)).slice(0, 3),
    focus: items(raw.focus, (id) => habitFocusLine(input, id)).slice(0, 2),
    nextStep: clip(raw.nextStep.trim() ? field(raw.nextStep, NEXT_STEP) : NEXT_STEP, 200),
  };
  return { data, codes: [...codes], fallback: false };
}
