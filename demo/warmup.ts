/**
 * Global setup: request each page the story visits once before the browser opens. `next dev`
 * compiles a route on its first request, and a first compile can reload an open page mid-click,
 * so a cold take could fail. Against a production build this is a few quick requests.
 */
const PATHS = ["/sign-in", "/today", "/habits", "/progress", "/settings"];

export default async function warmup(): Promise<void> {
  const base = (process.env.DEMO_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
  for (const p of PATHS) {
    try {
      // Signed out, protected pages redirect; the route still compiles. Don't follow redirects.
      await fetch(`${base}${p}`, { redirect: "manual", signal: AbortSignal.timeout(120_000) });
    } catch {
      // Best effort: a slow or failing page shows up in the story with a clearer error.
    }
  }
}
