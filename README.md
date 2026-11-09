# Habit and Goal Tracker

> A "Streaks for our users" app that wellness and coaching businesses can white-label: habits checked off in two taps,
> reminders that reach a phone without a native app, correct days in every time zone, and an AI coach that encourages
> and never gives health advice.

**Live:** https://app4.breakthruventures.ai · **Runs on:** Oracle Cloud (Always Free) · Part of
[30 apps in 30 days](https://github.com/BreakthruDevelopment/ai-dev-os)

> **Demo data only.** The AI summary may run on a free-tier model whose provider can keep prompts. Don't enter real
> health information. The app says the same on its home page and on every page that shows habits.

## What it does

The client problem: consumer wellness startups, coaching businesses and employee-wellbeing vendors need people to
check in daily, get nudged when something is still open, and read a short recap. Most can't ship a native app first.
This one is an installable web app (PWA) with Web Push, so reminders work on Android and on iPhone.

**Roles**

| Role | Can do |
| --- | --- |
| Public | See the home page; sign up or sign in |
| `user` | Create, edit, reorder, archive and delete their own habits; check in today and up to 7 days back; see streaks, weekly progress and a 30-day heatmap; set time zone and reminder time; turn reminders on or off per device; generate the weekly coach summary |
| `admin` | Everything a user can do with their own habits, plus: aggregate counts, the demo-workspace button, and account management (list users, change role, ban, delete) |

**Admin sees counts, not people's habits.** Habit names in a wellness app are personal ("Therapy homework"). Every habit
query filters on the owner, and another user's habit, check-in, summary or device is a 404 for everyone, admins
included. The admin page shows counts and daily-cap usage only. It does list account names, emails and roles, because
that is account management. Admins also can't become a user or reset a password: the impersonate, set-password and
set-email permissions are left off the admin role, and those paths return 404 as a second layer
(`src/lib/auth/permissions.ts`, `test/admin-permissions.integration.test.ts`).

### Habits

- **Yes/no** habits (checked or not) and **numeric** habits (a unit up to 16 characters and a daily target, for example
  "Read", pages, 20). A numeric check-in counts as done when its value reaches the target. The "done" flag is fixed when
  the check-in is written, so editing a target later doesn't rewrite history.
- A **weekly goal** of 1 to 7 days per habit. Names are up to 60 characters. Up to 20 active and 50 total habits per user.
- **Check-ins** can be written for today and the 7 days before it, never for the future, never before the habit existed,
  and not for archived habits. Repeating a check-in is harmless (one row per habit per day). Unchecking deletes the row.
- **Streaks follow the weekly goal.** A goal of 7 gives a *day streak*: consecutive done days, ending today, or
  yesterday while today is still open. A goal under 7 gives a *week streak*: consecutive ISO weeks that met the goal,
  ending this week if it's met, otherwise last week. "Best" is the longest run in the last 400 days. Changing a goal
  re-evaluates past weeks against the new goal.
- **ISO weeks** start on Monday and belong to the year that holds their Thursday, so 2027-01-01 is in `2026-W53`.
  Weeks are keyed by a continuous week number (Monday minus 2001-01-01, divided by 7), so streaks carry across year ends.
  The week view accepts the current week and the 51 before it; a week that doesn't exist (`2027-W53`) is a 400.
- Edit conflicts: editing a habit needs the `updatedAt` you loaded (409 when stale), and a habit's type can't change
  once it has check-ins.

### Local dates and daylight saving

"Today" is always computed on the server from the user's stored IANA time zone, never taken from the browser. A
check-in at 11:30 PM in Denver belongs to that Denver day, not to tomorrow in UTC. Dates travel as `YYYY-MM-DD`
strings and calendar maths runs on whole days, so the server's own zone and DST changes can't skew it. The zone is
detected from the browser on first sign-in, and users can change it, at most 3 times in any 24 hours.

### Reminders (Web Push)

- **Permission is asked only on a tap.** Settings has a "Turn on reminders on this device" button; nothing asks on page
  load. The panel explains each state in plain words: not supported, blocked (the site can't ask again, so it shows how
  to re-enable), or on, with "Send a test" and "Turn off on this device". A device list shows each device's label,
  added date and last delivery, with Remove.
- **iPhone and iPad need the Home Screen.** iOS only allows push for an installed web app, so in Safari the panel shows
  the steps (Share, Add to Home Screen, open Habits from there) instead of the button. Today also shows a dismissible
  install tip.
- **One reminder a day, at a time the user picks** (05:00 to 21:00 in 15-minute steps, in their own zone), sent only if
  at least one active habit is still open and its weekly goal isn't already met. It goes out from the chosen time for up
  to 3 hours and never past local midnight. A 12-hour gap stops a time-zone change from causing a second reminder.
- **Counts only in the notification**, for example "2 habits left today". Habit names never go in a payload, because
  notifications show on lock screens.
- **Dead devices clean themselves up.** A push service answering 404 or 410 deletes the subscription at once. Other
  failures are counted; a device is dropped after 10 failures in a row or 60 days without a success. A 429 pauses that
  push service for the rest of the run.
- **The scheduler runs inside the app.** On start, once migrations succeed, the server loads its keys and starts a timer:
  the first run 30 to 60 seconds later, then every 5 minutes. A run takes a Postgres advisory lock and claims each user
  before sending, so two instances or a restart never double-send (at worst a crash skips one day's reminder). This suits a
  long-lived container such as the Oracle VM, where the process stays up. It would not suit a platform that scales to
  zero, which would need an outside trigger. `REMINDER_SCHEDULER=off` turns it off (tests and CI smoke use that).
- The service worker (`public/sw.js`) handles push only. It has no `fetch` handler, so nothing is cached and there is no
  offline mode.
- Endpoints must be `https:` on a known push service (Google FCM, Mozilla, Apple, Windows), so the server can't be made to
  POST to arbitrary URLs.

**Delivery caveats.** Reminders are best effort. Android battery saver can delay or hold them. Desktop Firefox receives
them only while the browser is open. A push service drops a message the device can't take within 4 hours.

## The AI feature: weekly coach

On **Progress**, "Generate summary" writes a short, encouraging recap of the week from the user's own numbers: a
headline, a summary, up to 3 wins, up to 2 focus items and a next step. It goes through `generate()` in `src/lib/ai`
with the task `weekly-coach`. Live, it uses Gemini (default model `gemini-flash-lite-latest`, override with `AI_MODEL`).

**Cache and caps**

- One summary per user per ISO week, for this week or last week only. Opening the page never calls the model.
- Asking again with unchanged numbers returns the stored summary with no call. If the numbers changed, a refresh
  regenerates it. Each week allows 2 refreshes (3 model calls); after that the app says "This week's summary has been
  refreshed twice; it updates next week" and keeps showing the stored one.
- 6 coach calls per user per hour, and `COACH_DAILY_CAP` (default 200) across the whole app. A failed call spends nothing.
- A week with no check-ins makes no model call and shows a fixed fresh-start message.

**Safety**

- Input is statistics only: habits as `H1` to `H20`, counts, daily values, streaks. Habit names are stripped of angle
  brackets and line breaks and sent inside a `<stats>` block that the system prompt calls data, never instructions.
  The prompt is capped at 6,000 characters (daily values are dropped first, then names shortened) and the answer at
  600 output tokens. The model has no tools, and its output is display-only.
- The system prompt says the coach is not a health professional and must not give medical, health, nutrition, fitness,
  sleep or mental-health advice.
- The answer must pass a zod schema, then code checks in `src/lib/coach-guardrails.ts`: references to unknown habits are
  dropped; any number not in the user's stats is replaced; shame words are replaced; health language is replaced field
  by field, and in the headline or summary it swaps the whole answer for a neutral text built from the stats.
- The UI labels it "AI summary, not advice", shows a mode badge (live, demo, built from your numbers, no AI used) and
  puts the real numbers beside the text.
- Logs carry task, mode, counts, latency and guardrail codes. Never habit names, values or summary text.
- **Demo mode.** With no model key (the case on Oracle today), `generate()` answers from the recorded fixture in
  `src/lib/ai/demo.ts`, and the app builds the headline and summary from the user's own numbers, marked "Demo summary
  (built from your numbers, not from a live model)". If a live provider fails, nothing is stored and the user can retry.
- **Evals.** Five cases in `test/ai-evals.test.ts` (Ben's week, a habit name that tries to give instructions, health
  advice, an empty week, an invented number and unknown habit). `pnpm test` runs them with a stubbed model. To run them
  against live Gemini: `AI_PROVIDER=gemini GEMINI_API_KEY=... pnpm eval:coach`.

## Architecture

```
Browser (phone PWA or desktop)
   │ HTTPS + session cookie
   ▼
Caddy (TLS) ──► Next.js container ── pages, server actions, route handlers (/api/*)
                  │                  auth + roles, zod validation, AI gateway, JSON logs, /api/health
                  │                  in-process reminder scheduler (every 5 min)
                  ├──► Postgres (Drizzle): habits, check-ins, settings, devices, coach summaries, VAPID keys
                  ├──► Push services (FCM, Mozilla, Apple, Windows) with VAPID
                  └──► Gemini through generate(), or recorded demo answers
```

| Concern | Where |
| --- | --- |
| Dates, ISO weeks, time zones | `src/lib/time.ts` |
| Habits, check-ins, streaks and summaries | `src/lib/habits.ts`, `checkins.ts`, `progress.ts` |
| Settings and zone-change limit | `src/lib/settings.ts` |
| Push, reminder run, scheduler, keys | `src/lib/push.ts`, `reminder-scheduler.ts`, `vapid.ts`, `public/sw.js` |
| Coach | `src/lib/weekly-coach.ts`, `coach-guardrails.ts`, `coach.ts` |
| Caps and rate limits | `src/lib/usage.ts`, `src/lib/domain.ts` |
| Demo workspace | `src/lib/demo-workspace.ts`, `scripts/seed-demo.mts` |
| Config, validated at startup | `src/lib/env.ts` |
| Health check | `GET /api/health` (503 if the database is down; reports `push: "on"` or `"off"`, never a key) |

**VAPID keys.** Web Push needs a signing key pair. The app makes its own on first start and stores it in the
`app_settings` table, so nobody handles a secret. Creation runs under an advisory lock, so however many instances start
together, one pair is written. Only the public key leaves the server (`GET /api/push/config`); the private key is
never logged, returned or put in env. Trade-offs:

- **Rotating** means deleting the `app_settings` row and restarting every instance (each caches the pair in memory).
  That invalidates every subscription, and users turn reminders on again.
- **A database restore** brings back the same keys, so existing devices keep working. A copy of the database restored
  somewhere else could also send to production devices, so treat copies like production.
- **The private key sits in plain text** in the same database and backups as user data.
- **Shared superuser on Oracle.** Every app on the Oracle VM connects to the shared Postgres container as the `postgres`
  superuser with one password. A compromise of any app on that VM could read this database, the key included, and send
  notifications from this origin, as well as read habits. Per-app database roles are a follow-up in
  [30-apps-infra](https://github.com/BreakthruDevelopment/30-apps-infra).

## Security

- Authorization happens on the server on every page, route handler and data function. Every query filters on the owner;
  a check-in also has a composite foreign key to its habit's owner, so it can't attach to someone else's habit.
- Input is validated with zod at the boundary. Mutating routes require the app's own `Origin` and cap JSON bodies at 16 KB.
- Rate limits per user: 200 check-in writes an hour, 120 habit writes an hour, 20 device adds an hour, 3 test
  notifications an hour, 3 time-zone changes per 24 hours.
- Errors never return stack traces. Logs are JSON lines and carry no secrets, names or prompts.
- Demo accounts use a reserved email domain and marker that public sign-up can't claim.
- Tests: `test/*.integration.test.ts` run against real Postgres (ownership, admin limits, time zones and DST, push,
  coach caps, demo seed). `pnpm smoke` exercises the same rules end to end.

## Free-tier budget

| Resource | Control | Limit |
| --- | --- | --- |
| Oracle A1 VM | Always Free; one app container, one in-process reminder run every 5 min, up to 500 users per run | No charge |
| Database | Always Free VM disk; `DB_POOL_MAX` defaults to 5; one row per habit per day; backfill 7 days | No charge |
| Habits | 20 active and 50 total per user; 200 check-in and 120 habit writes per user per hour | Per user |
| Push services | VAPID needs no account; one reminder per user per day; `PUSH_DAILY_CAP` (default 2000) app-wide; 5 devices per user | Free |
| Gemini | One summary per user per week plus 2 refreshes, 6 calls per user per hour, `COACH_DAILY_CAP` (default 200) app-wide; no call for an empty week | Free tier |
| Demo loads | 1 per minute and 5 per UTC day, app-wide | Free |

The admin page shows today's use against each daily cap. Caps fail closed with a plain message.

## Run locally

```bash
cp .env.example .env.local          # then set BETTER_AUTH_SECRET (openssl rand -base64 32)
docker compose up -d db
pnpm install
pnpm db:migrate
pnpm dev                             # http://localhost:3000
```

To make yourself an admin: sign up, then `SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD=... pnpm db:seed` while
the app is running.

### Environment variables

Names only; never commit values. In the cloud they come from the host, not from this repo.

| Variable | Purpose |
| --- | --- |
| `APP_URL`, `APP_NAME` | Public URL (sign-in callbacks and cookies derive from it) and display name |
| `DATABASE_URL`, `DB_POOL_MAX` | Postgres connection and pool size |
| `BETTER_AUTH_SECRET` | Session signing secret, 32 characters or more |
| `MIGRATE_ON_START` | `true` applies pending migrations at startup |
| `AI_PROVIDER`, `AI_MODEL`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` | `demo` (default), `gemini` or `anthropic`. A provider without its key answers from the demo fixtures |
| `AI_FALLBACK_TO_DEMO`, `AI_TIMEOUT_MS`, `AI_EMBED_MODEL` | Fallback on provider errors, call timeout (default 20000), embedding model (unused by this app's features) |
| `VAPID_SUBJECT` | `mailto:` or `https:` contact for push services (public, not secret). No key variables exist |
| `REMINDER_SCHEDULER` | `on` (default) or `off` |
| `PUSH_DAILY_CAP`, `COACH_DAILY_CAP` | App-wide daily caps |
| `LOG_LEVEL` | `debug`, `info`, `warn` or `error` |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_USER_EMAIL`, `SEED_USER_PASSWORD` | Optional, for `pnpm db:seed` |
| `DEMO_SEED`, `DEMO_PASSWORD` | Required by `pnpm seed:demo` |

### Demo data

Three fictional users, Ada (America/Denver), Ben (Europe/London) and Cleo (Asia/Kolkata), at `@demo.breakthru.test`,
own 14 habits (yes/no and numeric) with 60 days of check-ins from a seeded generator: weekday strength, a weekend
dip, one broken streak and one long one. Each has a last-week coach summary in demo mode (no model call). No devices
are created.

- **Locally:** `DEMO_SEED=yes APP_URL=http://localhost:3000 DEMO_PASSWORD=<10+ characters> pnpm seed:demo`. Ada becomes
  an admin and all three get that password. It refuses the production URL, `*.sslip.io`, a database host named
  `postgres` and Cloud SQL sockets.
- **Live:** an admin clicks "Load demo workspace" on `/admin` (1 per minute, 5 per day). Demo users get random passwords
  nobody knows and no admin role. Every load rotates their passwords and signs them out, and replaces only the demo users'
  habits, check-ins, devices and summaries, never a real user's.

## Checks

```bash
pnpm lint && pnpm typecheck && pnpm test   # unit tests
TEST_DATABASE_URL=postgres://... pnpm test # plus data-layer tests against real Postgres
pnpm build && pnpm smoke                   # end-to-end smoke test against a running app
BASE_URL=https://app4.breakthruventures.ai REQUIRE_PUSH=1 pnpm smoke   # against the live app
```

CI runs these plus the container builds on every pull request. The smoke test signs up two throwaway users and checks
ownership (404 for the other user), conflicts, progress, push subscriptions (it never sends a real push), the coach
and cleanup.

## Deploy it yourself

Every push to `main` publishes a multi-arch image (amd64 and arm64) to GitHub Container Registry:
`ghcr.io/breakthrudevelopment/04-habit-tracker:sha-<commit>`. [30-apps-infra](https://github.com/BreakthruDevelopment/30-apps-infra)
deploys tags with Terraform; this repo holds no cloud credentials. With `MIGRATE_ON_START=true` the server applies
migrations before taking traffic, under an advisory lock. See `infra/README.md`.

| Cloud | Runs the container on | Reminders |
| --- | --- | --- |
| **Oracle Cloud (live)** | Docker Compose on the Always Free Ampere A1 VM, Caddy for TLS, shared Postgres container; listed in `apps.yaml` in 30-apps-infra | Work: the container is long-lived |
| AWS | Lambda behind API Gateway, RDS Postgres | The in-process scheduler needs a long-lived process; use an external trigger or leave it off |
| Azure | Container Apps, Flexible Server Postgres | Same caveat if the app scales to zero |
| Google Cloud | Cloud Run, Postgres on a small VM | Same caveat if the app scales to zero |

The app is deployed on Oracle only. On the other clouds the image runs, but this app's reminders have not been tried
there.

On Oracle, the coach runs in demo mode because that VM has no Gemini key. Set `GEMINI_API_KEY` with `AI_PROVIDER=gemini`
and the coach uses Gemini through `generate()`.

## 2-minute demo script

Reminders need HTTPS or localhost. For the full script, load the demo data locally (see "Demo data": Ben and Ada share
the `DEMO_PASSWORD` you chose). On the live site, the demo users' passwords are random, so use your own account there
and add one or two habits.

1. **Sign in as Ben on a phone.** Open Today. Each habit is a 44 px toggle or a number stepper. *Proves: built for
   thumbs, works at 375 px.*
2. **Check in "Meditate".** Tap the toggle. The streak and week dots update at once. *Proves: two-tap check-ins, streak
   rules, and a day keyed to Ben's own London date.*
3. **Open Settings, pick a reminder time, tap "Turn on reminders on this device."** The browser asks only now. On
   iPhone, add the app to the Home Screen first; the panel shows the steps. *Proves: permission on a tap, iOS handling.*
4. **Tap "Send a test".** A notification arrives on the phone; note it shows a count, not a habit name. *Proves: real
   Web Push without a native app, and counts-only payloads.*
5. **Open Progress and tap "Generate summary".** A recap appears labelled "AI summary, not advice", with a mode badge and
   the real numbers beside it. Tap again: it says the summary is up to date and makes no new call. *Proves: validated
   AI output, cache, and guardrails.*
6. **Sign in as Ada (admin) and open Admin.** The page shows only counts, caps in use and coach summaries by mode, never a
   habit name. There is no impersonate or set-password control. *Proves: admin sees counts only.*

## Design system

Every app shares the Breakthru look (tokens in `src/app/globals.css`, components in `src/components/ui/`; guide and
concept in `ai-dev-os/design/`). Header links come from `NAV_LINKS` in `src/lib/app-config.ts`: Today, Habits,
Progress, Settings, Admin (admins only).
