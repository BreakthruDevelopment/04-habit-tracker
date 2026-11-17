/**
 * Playwright config for the recorded product demo (not the unit tests; vitest only reads
 * src/**\/*.test.ts and test/**\/*.test.ts). See demo/README.md.
 *
 *   pnpm demo      headed Chromium at human speed, for Screen Studio
 *   pnpm demo:ci   headless, no pauses, as a quick smoke run
 */
import path from "node:path";
import { defineConfig } from "@playwright/test";
import { STORAGE_STATE } from "./helpers";

const baseURL = (process.env.DEMO_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const headless = process.env.DEMO_HEADLESS === "1";
const slowMo = Number(process.env.DEMO_SLOWMO ?? 400);

export default defineConfig({
  testDir: __dirname,
  globalSetup: path.join(__dirname, "warmup.ts"),
  outputDir: path.join(__dirname, "test-results"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // A take is a few minutes of deliberate pauses; give it room.
  timeout: 10 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: {
    baseURL,
    headless,
    viewport: { width: 1440, height: 900 },
    // Screen Studio records the window; Playwright's own video and traces stay off.
    video: "off",
    trace: "off",
    screenshot: "off",
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    launchOptions: {
      slowMo: Number.isFinite(slowMo) && slowMo >= 0 ? slowMo : 400,
      // Open the window at the viewport size so the recording has no blank margins.
      args: ["--window-size=1440,980"],
    },
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts$/, use: { browserName: "chromium" } },
    {
      name: "story",
      testMatch: /story\.spec\.ts$/,
      dependencies: ["setup"],
      use: {
        browserName: "chromium",
        // DEMO_BROWSER_CHANNEL=chrome uses the installed Google Chrome instead of Playwright's Chromium.
        channel: process.env.DEMO_BROWSER_CHANNEL || undefined,
        storageState: STORAGE_STATE,
      },
    },
  ],
  // Reuse a server you already started (recommended: a production build, see the README);
  // otherwise start `pnpm dev` for the run.
  webServer: process.env.DEMO_NO_SERVER === "1"
    ? undefined
    : {
        command: process.env.DEMO_SERVER_CMD ?? "pnpm dev",
        url: `${baseURL}/api/health`,
        reuseExistingServer: true,
        timeout: 180_000,
        stdout: "ignore",
        stderr: "pipe",
      },
});
