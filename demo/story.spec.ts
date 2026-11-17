/**
 * Habit Tracker demo story, about 45 seconds headed:
 *   add a habit -> check it off on Today -> Progress (streaks, 30-day heatmap, week by habit)
 *   -> set a reminder time in Settings.
 *
 * Signs in as a seeded demo user (default ada@demo.breakthru.test; see demo/README.md). Reload the
 * demo workspace before each take (`DEMO_SEED=yes pnpm seed:demo`): it replaces the demo users'
 * habits and clears their reminder time, so the story starts from the same place every time.
 */
import { expect, test } from "@playwright/test";
import { beat, finalHold, startDelay, typeSlowly } from "./helpers";

const HABIT = process.env.DEMO_HABIT ?? "Read 20 pages";
const REMINDER = process.env.DEMO_REMINDER ?? "8:00 PM";

test("Habit Tracker: add a habit, check it off, see progress, set a reminder", async ({ page }) => {
  await page.goto("/today");
  await expect(page.getByRole("heading", { name: "Today's habits" })).toBeVisible();
  await startDelay(page);

  // 1. Today: the seeded habits with this week's dots.
  await beat(page, 2_000);

  // 2. Add a new habit.
  const nav = page.getByRole("navigation", { name: "Main" });
  await nav.getByRole("link", { name: "Habits" }).click();
  const add = page.getByRole("region", { name: "Add a habit" });
  await expect(add).toBeVisible();
  await beat(page);
  await add.getByRole("textbox", { name: "Name" }).click();
  await typeSlowly(page, HABIT);
  await add.getByRole("combobox", { name: "Type" }).selectOption("check");
  await add.getByRole("combobox", { name: "Goal days per week" }).selectOption("5");
  await beat(page, 800);
  await add.getByRole("button", { name: "Add habit" }).click();
  await expect(page.getByRole("region", { name: /Your habits/ }).getByText(HABIT).first()).toBeVisible();
  await beat(page);

  // 3. Check it off on Today.
  await nav.getByRole("link", { name: "Today" }).click();
  await expect(page.getByRole("heading", { name: "Today's habits" })).toBeVisible();
  const done = page.getByRole("button", { name: `Done for ${HABIT}` });
  await done.scrollIntoViewIfNeeded();
  await beat(page, 800);
  await done.click();
  await expect(done).toHaveAttribute("aria-pressed", "true");
  await beat(page, 2_000);

  // 4. Progress: completion, streaks, the 30-day heatmap and the week by habit.
  await nav.getByRole("link", { name: "Progress" }).click();
  await expect(page.getByRole("heading", { name: "Your progress" })).toBeVisible();
  await beat(page, 2_000);
  await page.getByRole("region", { name: "Last 30 days" }).scrollIntoViewIfNeeded();
  await beat(page, 2_000);
  await page.getByRole("region", { name: /by habit/ }).scrollIntoViewIfNeeded();
  await beat(page);

  // 5. Settings: pick a daily reminder time and save.
  await nav.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  const reminder = page.getByRole("combobox", { name: "Reminder time" });
  await reminder.scrollIntoViewIfNeeded();
  await beat(page);
  await reminder.selectOption({ label: REMINDER });
  await beat(page, 800);
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText(`Saved. Reminders come at ${REMINDER}`)).toBeVisible();
  await beat(page);
  await page.getByRole("region", { name: "Reminders on this device" }).scrollIntoViewIfNeeded();
  await finalHold(page);
});
