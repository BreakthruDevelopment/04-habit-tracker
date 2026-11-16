/**
 * Signs the demo account in once and saves the session to demo/.auth/ (gitignored), so the
 * recorded story never shows a sign-in screen. The password comes only from the environment; it is
 * the same DEMO_PASSWORD `pnpm seed:demo` gives the seeded demo users:
 *
 *   DEMO_PASSWORD=... pnpm demo          # signs in as ada@demo.breakthru.test
 *   DEMO_EMAIL=ben@demo.breakthru.test DEMO_PASSWORD=... pnpm demo
 *
 * A saved session that still opens /today is reused; DEMO_REAUTH=1 forces a fresh sign-in.
 */
import fs from "node:fs";
import path from "node:path";
import { expect, test as setup, type BrowserContext } from "@playwright/test";
import { STORAGE_STATE } from "./helpers";

/** A signed-in-only page; a stale session is redirected from here to /sign-in. */
const CHECK_PATH = "/today";
const DEFAULT_EMAIL: string | undefined = "ada@demo.breakthru.test";

setup("sign in the demo account", async ({ page }) => {
  if (process.env.DEMO_REAUTH !== "1" && fs.existsSync(STORAGE_STATE)) {
    const saved = JSON.parse(fs.readFileSync(STORAGE_STATE, "utf8")) as { cookies?: Parameters<BrowserContext["addCookies"]>[0] };
    await page.context().addCookies(saved.cookies ?? []);
    await page.goto(CHECK_PATH);
    const stillSignedIn = !new URL(page.url()).pathname.startsWith("/sign-in");
    setup.skip(stillSignedIn, "Reusing the saved demo session");
    await page.context().clearCookies();
  }

  const email = process.env.DEMO_EMAIL || DEFAULT_EMAIL;
  const password = process.env.DEMO_PASSWORD;
  if (!email || !password) {
    throw new Error("Set DEMO_PASSWORD to the password you seeded the demo workspace with (see demo/README.md). It is never committed.");
  }

  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  // The form leaves /sign-in on success and shows an alert on failure; stop at whichever comes first.
  // Scoped to the form: Next.js also renders an (empty) route-announcer alert.
  const alert = page.locator("form").getByRole("alert").first();
  const failure = await Promise.race([
    page.waitForURL((url) => !url.pathname.startsWith("/sign-in")).then(() => null),
    alert.waitFor().then(
      async () => (await alert.textContent())?.trim() || "Sign-in failed",
      () => null,
    ),
  ]);
  if (failure) throw new Error(`${failure}. Is the demo account seeded? See demo/README.md.`);
  await expect(page).not.toHaveURL(/\/sign-in/);

  fs.mkdirSync(path.dirname(STORAGE_STATE), { recursive: true });
  await page.context().storageState({ path: STORAGE_STATE });
});
