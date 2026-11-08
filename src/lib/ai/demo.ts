/**
 * Recorded answers keyed by task name. Demo mode keeps live demos working when the
 * free model quota is used up, and lets tests run without a network or API key.
 * Each app adds a fixture for each AI task it defines.
 */
export const demoFixtures: Record<string, unknown> = {
  // Issue 6 owns the weekly coach; this is its recorded answer (no digits, so it passes the number check).
  "weekly-coach": {
    headline: "A steady week with real momentum",
    summary:
      "Demo summary (recorded, not from a live model): you showed up on most days and kept your best streak going. Midweek was your strongest stretch.",
    wins: [{ habit: "H1", text: "You reached your weekly goal." }],
    focus: [{ habit: "H2", text: "Try pairing this one with something you already do every day." }],
    nextStep: "Pick the hardest day next week and plan a smaller version of each habit for it.",
  },
};

export function demoAnswer(task: string): string {
  const fixture = demoFixtures[task];
  if (fixture === undefined) {
    throw new Error(`No demo fixture for AI task "${task}". Add one to src/lib/ai/demo.ts.`);
  }
  return JSON.stringify(fixture);
}
