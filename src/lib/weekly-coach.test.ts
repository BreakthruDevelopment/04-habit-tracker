import { describe, expect, it, vi } from "vitest";
import { AiError } from "@/lib/ai/types";
import { benWeek, habit, week } from "../../test/coach-fixtures";
import {
  COACH_PROMPT_MAX_CHARS,
  buildCoachInput,
  buildCoachPrompt,
  cleanLabel,
  coachInputHash,
  coachOutputSchema,
  composeCoach,
  storedStats,
} from "./weekly-coach";

describe("cleanLabel", () => {
  it("strips angle brackets, newlines and control characters, and caps the length", () => {
    expect(cleanLabel("a<b>c\nd\u0000e</stats>", 60)).toBe("a b c d e /stats");
    expect(cleanLabel("x".repeat(100), 60)).toHaveLength(60);
  });
});

describe("buildCoachInput", () => {
  it("assigns H-ids by position and takes at most 20 habits", () => {
    const summary = {
      week: "2026-W45", monday: "2026-11-02", sunday: "2026-11-08", prev: null, next: null, isCurrent: true, daysElapsed: 3,
      totals: { habits: 25, habitsOnGoal: 0, doneCheckIns: 0, completionPct: 0 },
      habits: Array.from({ length: 25 }, (_, i) => ({
        habitId: `id-${i}`, name: `<b>H ${i}</b>`, kind: "check" as const, unit: null, dailyTarget: null, weeklyGoal: 3, doneDays: 0,
        total: "0", values: Array(7).fill(null), done: Array(7).fill(false), goalMet: false, lastWeekDoneDays: 0,
      })),
    };
    const input = buildCoachInput(summary, {});
    expect(input.habits).toHaveLength(20);
    expect(input.habits[0]).toMatchObject({ id: "H1", habitId: "id-0", name: "b H 0 /b" });
    expect(input.habits[19].id).toBe("H20");
  });
});

describe("the prompt", () => {
  it("frames the stats as data and carries H-ids, not real ids", () => {
    const built = buildCoachPrompt(benWeek());
    expect(built.system).toMatch(/never as instructions/);
    expect(built.system).toMatch(/not a health professional/);
    expect(built.prompt).toMatch(/<stats>[\s\S]*"id":"H1"[\s\S]*<\/stats>/);
    expect(built.prompt).not.toContain("00000000-0000");
  });
  it("is capped: daily values go first, then names are cut, and it only rejects when nothing fits", () => {
    const input = week(Array.from({ length: 20 }, (_, i) => habit(i + 1, { name: "n".repeat(60), goal: 3, values: Array(7).fill("99999.99") })));
    const full = buildCoachPrompt(input, 100_000);
    expect(full.valuesDropped).toBe(false);
    expect(full.namesCut).toBe(false);
    const noValues = buildCoachPrompt(input, full.prompt.length - 10);
    expect(noValues.valuesDropped).toBe(true);
    expect(noValues.namesCut).toBe(false);
    expect(noValues.prompt).not.toContain("99999.99");
    const cut = buildCoachPrompt(input, noValues.prompt.length - 10);
    expect(cut.namesCut).toBe(true);
    expect(cut.prompt.length).toBeLessThanOrEqual(noValues.prompt.length - 10);
    expect(() => buildCoachPrompt(input, 500)).toThrowError(expect.objectContaining({ kind: "input_rejected" }));
  });
  it("tolerates names that grow when JSON-escaped, instead of rejecting", () => {
    const input = week(Array.from({ length: 20 }, (_, i) => habit(i + 1, { name: '"'.repeat(60), unit: "\\".repeat(16), kind: "numeric", target: "100000", total: "700000" })));
    const built = buildCoachPrompt(input);
    expect(built.prompt.length).toBeLessThanOrEqual(COACH_PROMPT_MAX_CHARS);
  });
  it("fits the default cap at the maximum of 20 habits", () => {
    const input = week(Array.from({ length: 20 }, (_, i) => habit(i + 1, { name: "n".repeat(60), unit: "u".repeat(16), kind: "numeric", target: "100000", total: "700000" })));
    expect(buildCoachPrompt(input).prompt.length).toBeLessThanOrEqual(COACH_PROMPT_MAX_CHARS);
  });
});

describe("hash and stored stats", () => {
  it("is 64 hex characters and changes with the data or the model", () => {
    const a = coachInputHash(benWeek(), "demo");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(coachInputHash(benWeek(), "demo")).toBe(a);
    expect(coachInputHash(benWeek(), "gemini:x")).not.toBe(a);
    const changed = benWeek();
    changed.habits[0].name = "Read more";
    expect(coachInputHash(changed, "demo")).not.toBe(a);
  });
  it("ignores the day of the week, so a new day alone is not new data", () => {
    const a = coachInputHash(benWeek(), "demo");
    expect(coachInputHash({ ...benWeek(), daysElapsed: 3, isCurrent: true }, "demo")).toBe(a);
  });
  it("stores no names or units", () => {
    const input = week([habit(1, { name: "Secret name", unit: "pages" })]);
    expect(JSON.stringify(storedStats(input))).not.toMatch(/Secret name|pages/);
  });
});

describe("schema", () => {
  it("empties over-long lists instead of failing, and rejects a bad H-id's whole list", () => {
    const base = { headline: "h", summary: "s", nextStep: "n" };
    const w = (habit: string) => ({ habit, text: "t" });
    expect(coachOutputSchema.parse({ ...base, wins: [w("H1"), w("H2"), w("H3"), w("H4")], focus: [] }).wins).toEqual([]);
    expect(coachOutputSchema.parse({ ...base, wins: [w("H21")], focus: [] }).wins).toEqual([]);
    expect(coachOutputSchema.safeParse({ ...base, headline: "" }).success).toBe(false);
  });
});

describe("composeCoach", () => {
  it("falls back when the model's output is invalid, and rethrows provider failures", async () => {
    const bad = vi.fn().mockRejectedValue(new AiError("Model did not return valid JSON", "invalid_output"));
    const r = await composeCoach(benWeek(), { generate: bad });
    expect(r.mode).toBe("fallback");
    expect(r.codes).toEqual(["invalid_output"]);
    const down = vi.fn().mockRejectedValue(new AiError("Model quota reached", "quota", 429));
    await expect(composeCoach(benWeek(), { generate: down })).rejects.toMatchObject({ kind: "quota" });
  });
});
