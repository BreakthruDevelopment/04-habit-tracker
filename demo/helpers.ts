/**
 * Pacing helpers for the Screen Studio demo. Nothing here talks to the app; it only decides how
 * long to wait so a recording reads well. `pnpm demo:ci` turns every pause off.
 */
import path from "node:path";
import type { Page } from "@playwright/test";

/** Where the signed-in demo session is saved (gitignored). */
export const STORAGE_STATE = path.join(__dirname, ".auth", "demo-user.json");

function ms(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Pause before the first action, so there is time to start a Screen Studio window recording. */
export const START_DELAY_MS = ms("DEMO_START_DELAY", 5_000);
/** Hold on the last screen before the browser closes. */
export const FINAL_HOLD_MS = ms("DEMO_FINAL_HOLD", 3_000);
/** DEMO_BEATS=off skips the reading pauses (the headless smoke run sets it). */
const BEATS_ON = process.env.DEMO_BEATS !== "off";

/** A reading pause after a key moment: lets Screen Studio's zoom settle and viewers catch up. */
export async function beat(page: Page, duration = 1_500): Promise<void> {
  if (BEATS_ON && duration > 0) await page.waitForTimeout(duration);
}

/** Call once, after the first page has loaded and before the first click. */
export async function startDelay(page: Page): Promise<void> {
  if (START_DELAY_MS > 0) await page.waitForTimeout(START_DELAY_MS);
}

/** Call once at the end of the story. */
export async function finalHold(page: Page): Promise<void> {
  if (FINAL_HOLD_MS > 0) await page.waitForTimeout(FINAL_HOLD_MS);
}

/** Type like a person on camera; instant in the headless smoke run. */
export async function typeSlowly(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: BEATS_ON ? 35 : 0 });
}
