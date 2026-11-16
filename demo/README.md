# Recorded demo (Playwright + Screen Studio)

`demo/` holds a scripted walkthrough of the Habit Tracker. Playwright drives a visible Chromium window
at human speed; [Screen Studio](https://www.screen.studio/) records that window on the Mac and adds the
polish (auto-zoom on clicks, smooth cursor, background). Every take is the same, so a re-record is a
re-run.

This is separate from the unit tests: vitest only reads `src/**/*.test.ts` and `test/**/*.test.ts`.

## The story (about 45 seconds)

1. **Today**: the seeded habits with this week's dots.
2. **Habits** → Add a habit: "Read 20 pages", Yes or no, 5 days a week → **Add habit**.
3. Back on **Today**, press **Done** on the new habit.
4. **Progress**: completion and streak tiles, the last 30 days heatmap, and the week by habit (with
   the coach summary panel).
5. **Settings**: set **Reminder time** to 8:00 PM and **Save settings**, then show the device
   reminders panel.

The story doesn't turn on push notifications: that needs a browser permission prompt, which doesn't
record well.

## One-time setup

```bash
pnpm install
pnpm exec playwright install chromium     # browser for Playwright (or set DEMO_BROWSER_CHANNEL=chrome)
docker compose up -d db                   # local Postgres, if you don't have one
cp .env.example .env.local                # set BETTER_AUTH_SECRET
set -a; source .env.local; set +a
pnpm db:migrate
```

## Demo data and account

The existing demo seed creates three fictional users (Ada, Ben and Cleo at `@demo.breakthru.test`)
with realistic habits and about eight weeks of check-ins (a dip, one broken streak and one long one). It
refuses production hosts. Pick a password of at least 10 characters and keep it out of the repo:

```bash
export DEMO_PASSWORD="..."                 # type it, don't commit it
DEMO_SEED=yes pnpm seed:demo
```

The demo signs in as **ada@demo.breakthru.test** with that same `DEMO_PASSWORD` (`DEMO_EMAIL` picks
another seeded user). Run the seed again **before every take**: it replaces the demo users' habits
(so "Read 20 pages" is gone) and clears the reminder time. Reloading signs the old session out; the
demo notices and signs in again on its own.

## AI

The story shows the Progress page's coach summary as it is; it doesn't press anything that calls a
model. With `AI_PROVIDER=demo` (no key) the summary is built from the user's own numbers and marked
as a demo summary. To show a live summary, set your own `AI_PROVIDER=gemini` and `GEMINI_API_KEY` in
`.env.local`.

## Recording a take

1. Start the app. For a clean recording use a production build, which has no Next.js dev badge:
   `pnpm build && cp -r public .next/standalone/ && cp -r .next/static .next/standalone/.next/ && node .next/standalone/server.js`.
   `pnpm dev` also works (the demo starts it for you if nothing is listening on port 3000).
2. Reset the data: `DEMO_SEED=yes pnpm seed:demo`.
3. Run `pnpm demo` (with `DEMO_PASSWORD` exported). It signs in once and saves the session to
   `demo/.auth/` (gitignored).
4. A 1440×900 Chromium window opens on Today and waits 5 seconds. In that time, start Screen Studio,
   choose **Window** and click the Chromium window.
5. Playwright plays the story, holds the last screen for 3 seconds and closes the window. Stop the
   recording during the hold.
6. Trim the start and end in Screen Studio and export.

## Settings (environment variables)

| Variable | Default | What it does |
| --- | --- | --- |
| `DEMO_PASSWORD` | none | Password of the seeded demo users. Only needed when no valid saved session exists. |
| `DEMO_EMAIL` | `ada@demo.breakthru.test` | Seeded user to sign in as. |
| `DEMO_BASE_URL` | `http://localhost:3000` | App to drive. Never point it at production. |
| `DEMO_HABIT` | `Read 20 pages` | Name of the habit the story adds. |
| `DEMO_REMINDER` | `8:00 PM` | Reminder time picked in Settings (5:00 AM to 9:00 PM, 15-minute steps). |
| `DEMO_SLOWMO` | `400` | Milliseconds between Playwright actions. |
| `DEMO_START_DELAY` | `5000` | Milliseconds to wait before the first click. |
| `DEMO_FINAL_HOLD` | `3000` | Milliseconds to hold the last screen. |
| `DEMO_BEATS` | on | `off` skips the reading pauses. |
| `DEMO_HEADLESS` | unset | `1` runs without a window. |
| `DEMO_REAUTH` | unset | `1` signs in again even if the saved session still works. |
| `DEMO_BROWSER_CHANNEL` | unset | `chrome` uses installed Google Chrome. |
| `DEMO_SERVER_CMD` | `pnpm dev` | Command used to start the app if nothing answers `/api/health`. |
| `DEMO_NO_SERVER` | unset | `1` never starts a server. |

## Headless smoke run

`pnpm demo:ci` runs the same story headless with no pauses (a few seconds). It isn't wired into CI
yet; it can become a smoke test later.
