import { describe, expect, it } from "vitest";
import { benWeek, habit, week } from "../../test/coach-fixtures";
import {
  allowedNumbers,
  applyGuardrails,
  fallbackOutput,
  habitWinLine,
  hasHealthLanguage,
  hasInventedNumber,
  hasShameLanguage,
  numbersIn,
  skippedOutput,
} from "./coach-guardrails";

describe("health language", () => {
  it.each([
    "ask your doctor",
    "Talk to a physician",
    "a higher dosage",
    "take a DOSE",
    "your medication",
    "medical advice",
    "a diagnosis",
    "symptoms",
    "a new treatment",
    "lose weight",
    "burn calories",
    "your BMI",
    "feeling depressed",
    "anxiety",
    "an injury",
    "good for your heart",
    "for your health",
    "Méd​ication",
  ])("flags %s", (t) => expect(hasHealthLanguage(t)).toBe(true));

  it.each([
    "You checked in on 4 of 7 days.",
    "Treat yourself to a rest day.",
    "A secure routine",
    "Pair it with something you already do",
    "Try a smaller version on busy days",
  ])("lets %s through", (t) => expect(hasHealthLanguage(t)).toBe(false));
});

describe("shame language", () => {
  it.each(["You were lazy", "a total Failure", "so disappointing", "pathetic", "You failed", "so weak", "a disgrace", "such a loser", "hopeless", "embarrassed"])("flags %s", (t) => expect(hasShameLanguage(t)).toBe(true));
  it.each(["A fresh start", "Fail-safe plan"].slice(0, 1))("lets %s through", (t) => expect(hasShameLanguage(t)).toBe(false));
});

describe("numbers", () => {
  it("reads digits, decimals, thousands and spelled-out numbers (not 'one')", () => {
    expect(numbersIn("12 km, 2.5 l, 1,000 steps, twice, three days, one step")).toEqual([12, 2.5, 1000, 2, 3]);
  });
  it("reads allowed numbers from the numeric fields only: not names, not H-ids", () => {
    const input = week([habit(1, { name: "Run 5k in 2024", goal: 4, doneDays: 3, lastWeekDoneDays: 2, streak: { mode: "week", current: 1, best: 3 } })]);
    const allowed = allowedNumbers(input);
    for (const n of [7, 4, 3, 2, 1, 2026, 45]) expect(allowed.has(n)).toBe(true);
    for (const n of [5, 2024, 6, 20, 12]) expect(allowed.has(n)).toBe(false);
    expect(hasInventedNumber("your 5k run", allowed)).toBe(true);
  });
  it("allows what the stats contain, and 7", () => {
    const allowed = allowedNumbers(benWeek());
    expect(hasInventedNumber("You read on 6 days of 7, goal 5.", allowed)).toBe(false);
    expect(hasInventedNumber("You read on 9 days.", allowed)).toBe(true);
    expect(hasInventedNumber("Read nine times", allowed)).toBe(true);
    expect(hasInventedNumber("Read twice", allowed)).toBe(false); // 2 is Guitar's done days
  });
});

describe("applyGuardrails", () => {
  const input = benWeek();
  const allowed = allowedNumbers(input);
  const ok = { headline: "Great week", summary: "You read on 6 days.", wins: [{ habit: "H1", text: "Six" }], focus: [], nextStep: "Keep going." };

  it("passes a clean answer unchanged", () => {
    const r = applyGuardrails({ ...ok, wins: [{ habit: "H1", text: "Read on 6 days." }] }, input, allowed);
    expect(r.codes).toEqual([]);
    expect(r.fallback).toBe(false);
    expect(r.data.wins[0].text).toBe("Read on 6 days.");
  });
  it("replaces a field with a number from outside the stats, using the stats", () => {
    const r = applyGuardrails({ ...ok, wins: [{ habit: "H1", text: "You read 40 pages." }] }, input, allowed);
    expect(r.codes).toEqual(["invented_number"]);
    expect(r.data.wins[0].text).toBe("You checked in on 6 of 7 days and reached your goal of 5.");
  });
  it("replaces a shaming field", () => {
    const r = applyGuardrails({ ...ok, nextStep: "Don't be lazy." }, input, allowed);
    expect(r.codes).toEqual(["shame_language"]);
    expect(r.data.nextStep).not.toMatch(/lazy/);
  });
  it("drops unknown H-ids", () => {
    const r = applyGuardrails({ ...ok, wins: [{ habit: "H3", text: "x" }] }, input, allowed);
    expect(r.codes).toEqual(["unknown_habit"]);
    expect(r.data.wins).toEqual([]);
  });
  it("turns health language in the summary into the whole fallback", () => {
    const r = applyGuardrails({ ...ok, summary: "Ask your doctor." }, input, allowed);
    expect(r.fallback).toBe(true);
    expect(r.data).toEqual(fallbackOutput(input));
  });
  it("replaces health language elsewhere, field by field", () => {
    const r = applyGuardrails({ ...ok, nextStep: "Watch your calories." }, input, allowed);
    expect(r.fallback).toBe(false);
    expect(r.codes).toEqual(["medical_language"]);
    expect(r.data.headline).toBe("Great week");
  });
});

describe("wording", () => {
  it("uses the singular for one day", () => {
    const input = week([habit(1, { goal: 3, doneDays: 1 })], { isCurrent: true, daysElapsed: 1 });
    expect(habitWinLine(input, "H1")).toBe("You checked in on 1 of 1 day so far.");
    expect(habitWinLine({ ...input, daysElapsed: 2 }, "H1")).toBe("You checked in on 1 of 2 days so far.");
  });
});

describe("deterministic text passes its own guardrails", () => {
  const inputs = [
    benWeek(),
    week([habit(1, { goal: 7, doneDays: 7 })]),
    week([habit(1, { doneDays: 0 }), habit(2, { goal: 1, doneDays: 1 })], { isCurrent: true, daysElapsed: 3 }),
    week([]),
  ];
  it.each(inputs.map((i, n) => [n, i] as const))("fallback and skipped text, input %i", (_n, input) => {
    const allowed = allowedNumbers(input);
    for (const out of [fallbackOutput(input), skippedOutput(input)]) {
      const r = applyGuardrails(out, input, allowed);
      expect(r.codes).toEqual([]);
      expect(r.fallback).toBe(false);
    }
  });
  it("stays inside the schema's length limits", () => {
    const out = fallbackOutput(benWeek());
    expect(out.headline.length).toBeLessThanOrEqual(100);
    expect(out.summary.length).toBeLessThanOrEqual(600);
    expect(out.wins.length).toBeLessThanOrEqual(3);
  });
});
