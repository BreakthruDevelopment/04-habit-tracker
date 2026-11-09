/** Hand-built coach inputs for the unit tests and the evals (no database). */
import type { CoachHabit, CoachInput } from "@/lib/weekly-coach";

export function habit(n: number, over: Partial<CoachHabit> = {}): CoachHabit {
  const doneDays = over.doneDays ?? 3;
  return {
    id: `H${n}`,
    habitId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    name: `Habit ${n}`,
    unit: null,
    kind: "check",
    target: null,
    goal: 5,
    doneDays,
    values: Array.from({ length: 7 }, (_, i) => (i < doneDays ? "1" : null)),
    total: String(doneDays),
    lastWeekDoneDays: 2,
    streak: { mode: "week", current: 1, best: 3 },
    ...over,
  };
}

export function week(habits: CoachHabit[], over: Partial<CoachInput> = {}): CoachInput {
  const goalSum = habits.reduce((n, h) => n + h.goal, 0);
  const counted = habits.reduce((n, h) => n + Math.min(h.doneDays, h.goal), 0);
  return {
    week: "2026-W45",
    daysElapsed: 7,
    isCurrent: false,
    totals: {
      habits: habits.length,
      habitsOnGoal: habits.filter((h) => h.doneDays >= h.goal).length,
      doneCheckIns: habits.reduce((n, h) => n + h.doneDays, 0),
      completionPct: goalSum === 0 ? 0 : Math.round((100 * counted) / goalSum),
    },
    habits,
    ...over,
  };
}

/** Ben's seeded week: "Read" (goal 5) done 6 days, "Guitar practice" (goal 4) done 2. */
export const benWeek = () =>
  week([habit(1, { name: "Read", goal: 5, doneDays: 6, lastWeekDoneDays: 4 }), habit(2, { name: "Guitar practice", goal: 4, doneDays: 2, lastWeekDoneDays: 3 })]);
