#!/usr/bin/env bash
# End-to-end smoke test against a running app (local, CI, or a deployed URL).
# Checks health, the signed-out redirects, sign-up, and that signed-in users reach their pages while
# admin pages and admin-only auth endpoints stay closed, then walks the habit flow: habits, check-ins, ownership,
# conflicts, progress, web push subscriptions, the weekly coach and deleting a habit with its check-ins.
#   BASE_URL=https://app4.breakthruventures.ai ./scripts/smoke.sh
#
# BASE_URL must be the app's own public URL (APP_URL): mutating routes require that Origin.
# Needs curl, jq and node (for a real P-256 test key). Signs up two throwaway users (smoke-a-*@example.test and
# smoke-b-*@example.test; they stay behind). The habits and the dummy push device are deleted even when a check fails.
#   REQUIRE_PUSH=1  push must be configured (VAPID keys): CI and the live run set it. Otherwise the push
#                   subscription checks are skipped when /api/push/config says enabled: false.
# The coach may answer in mode "live" or "demo" (no model key): both pass. The script never sends a real push.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
BASE_URL="${BASE_URL%/}"
REQUIRE_PUSH="${REQUIRE_PUSH:-0}"
RUN_ID="$(date +%s)$RANDOM"
JAR_A="$(mktemp)"; JAR_B="$(mktemp)"
HABITS=(); PUSH_ENDPOINT=""

# Every request gets a time limit and no URL globbing.
curl() { command curl --max-time 30 --globoff "$@"; }

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }
warn() { echo "warn - $*" >&2; }
command -v jq >/dev/null || fail "jq is required"
command -v node >/dev/null || fail "node is required (to make a push test key)"

# Best effort: A deletes what the run created. Never changes the exit code.
cleanup() {
  local code=$?
  set +e
  local id
  if [ -n "$PUSH_ENDPOINT" ]; then
    curl -s -o /dev/null -b "$JAR_A" -X DELETE -H 'content-type: application/json' -H "origin: $BASE_URL" \
      -d "{\"endpoint\":\"$PUSH_ENDPOINT\"}" "$BASE_URL/api/push/subscriptions"
  fi
  for id in ${HABITS[@]+"${HABITS[@]}"}; do
    curl -s -o /dev/null -b "$JAR_A" -X DELETE -H "origin: $BASE_URL" "$BASE_URL/api/habits/$id"
  done
  rm -f "$JAR_A" "$JAR_B"
  exit $code
}
trap cleanup EXIT

# The app (and its database) may still be starting: wait up to 90 s.
health=""
for _ in $(seq 1 90); do
  health=$(curl -fsS "$BASE_URL/api/health" 2>/dev/null) && break
  health=""; sleep 1
done
[ -n "$health" ] || fail "health endpoint not ready after 90 s at $BASE_URL"
echo "$health" | jq -e '.status == "ok"' >/dev/null || fail "health not ok: $health"
pass "health check"

for path in / /sign-in; do
  page=$(curl -fsS "$BASE_URL$path") || fail "page $path did not render"
  echo "$page" | grep -q 'Explore breakthruventures.ai' || fail "page $path is missing the shared footer"
done
pass "pages render inside the shared shell"

for path in /today /admin; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL$path")
  [ "$code" = "307" ] || fail "signed-out $path should redirect (307), got $code"
done
pass "signed-out Today and admin redirect"

signup() {
  local jar=$1 email=$2
  curl -fsS -c "$jar" -b "$jar" -H 'content-type: application/json' -H "origin: $BASE_URL" \
    -d "{\"email\":\"$email\",\"password\":\"smoke-test-password-1\",\"name\":\"Smoke\"}" \
    "$BASE_URL/api/auth/sign-up/email" >/dev/null || fail "sign-up failed for $email"
}

signup "$JAR_A" "smoke-a-$RUN_ID@example.test"
signup "$JAR_B" "smoke-b-$RUN_ID@example.test"
pass "two users signed up"

# Both users now have a session cookie: each can open Today, and neither is an admin.
for jar in "$JAR_A" "$JAR_B"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" "$BASE_URL/today")
  [ "$code" = "200" ] || fail "signed-in /today should be 200, got $code"
  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" "$BASE_URL/settings")
  [ "$code" = "200" ] || fail "signed-in /settings should be 200, got $code"
  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" "$BASE_URL/admin")
  [ "$code" = "307" ] || fail "a plain user opening /admin should be redirected (307), got $code"
done
pass "signed-in users reach Today; /admin stays closed to them"

# The session works for API calls too, and signing out ends it.
session=$(curl -fsS -b "$JAR_A" "$BASE_URL/api/auth/get-session") || fail "get-session failed"
echo "$session" | grep -q "smoke-a-$RUN_ID@example.test" || fail "session is for the wrong user: $session"
pass "session identifies the user"

# Admins can't become other users or set their passwords, and a plain user can't call admin endpoints at all.
for endpoint in impersonate-user set-user-password; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" \
    -d '{"userId":"x","newPassword":"another-long-password"}' "$BASE_URL/api/auth/admin/$endpoint")
  case "$code" in 403|404) ;; *) fail "admin/$endpoint should be refused, got $code" ;; esac
done
pass "admin impersonation and password reset endpoints are closed"

# --- The habit flow ---
# req JAR METHOD PATH [BODY]: sets $CODE and $BODY (not in a subshell, so callers can read both).
req() {
  local jar=$1 method=$2 path=$3 body=${4:-}
  local out; out=$(mktemp)
  if [ -n "$body" ]; then
    CODE=$(curl -s -o "$out" -w '%{http_code}' -b "$jar" -X "$method" -H 'content-type: application/json' -H "origin: $BASE_URL" -d "$body" "$BASE_URL$path")
  else
    CODE=$(curl -s -o "$out" -w '%{http_code}' -b "$jar" -X "$method" -H "origin: $BASE_URL" "$BASE_URL$path")
  fi
  BODY=$(cat "$out"); rm -f "$out"
}
expect() { [ "$CODE" = "$1" ] || fail "$2: expected $1, got $CODE ($(printf '%s' "$BODY" | head -c 500))"; }

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/habits")
[ "$code" = "401" ] || fail "signed-out GET /api/habits should be 401, got $code"

req "$JAR_A" GET /api/settings; expect 200 "settings before first sign-in"
echo "$BODY" | jq -e '.settings == null' >/dev/null || fail "GET /api/settings must not create the row: $BODY"
req "$JAR_A" POST /api/settings/detect '{"detectedZone":"America/Denver"}'; expect 200 "detect zone"
echo "$BODY" | jq -e '.settings.timeZone == "America/Denver"' >/dev/null || fail "settings did not take the detected zone: $BODY"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_B" -X POST -H 'content-type: application/json' -H 'origin: https://evil.example' -d '{"detectedZone":"Asia/Tokyo"}' "$BASE_URL/api/settings/detect")
[ "$code" = "403" ] || fail "cross-origin detect should be 403, got $code"
req "$JAR_B" GET /api/settings; echo "$BODY" | jq -e '.settings == null' >/dev/null || fail "cross-origin detect created settings: $BODY"
req "$JAR_A" PATCH /api/settings '{"reminderTime":"20:00"}'; expect 200 "set reminder time"
pass "time zone and reminder time"

req "$JAR_A" POST /api/habits '{"name":"Read","weeklyGoal":5}'; expect 201 "create yes/no habit"
yes_id=$(echo "$BODY" | jq -r .habit.id); HABITS+=("$yes_id"); yes_at=$(echo "$BODY" | jq -r .habit.updatedAt)
req "$JAR_A" POST /api/habits '{"name":"Water","kind":"numeric","unit":"glasses","dailyTarget":"8"}'; expect 201 "create numeric habit"
num_id=$(echo "$BODY" | jq -r .habit.id); HABITS+=("$num_id")
req "$JAR_A" GET /api/today; expect 200 "today"
today=$(echo "$BODY" | jq -r .date)
[[ "$today" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || fail "today has no date: $BODY"

req "$JAR_A" PUT "/api/habits/$yes_id/check-ins/$today" '{}'; expect 200 "check in"
req "$JAR_A" PUT "/api/habits/$yes_id/check-ins/$today" '{}'; expect 200 "check in again"
req "$JAR_A" PUT "/api/habits/$num_id/check-ins/$today" '{"value":"8"}'; expect 200 "numeric check in"
req "$JAR_A" GET /api/today; expect 200 "today"
n=$(echo "$BODY" | jq '[.habits[] | select(.done)] | length'); [ "$n" = "2" ] || fail "expected 2 done habits, got $n"
pass "habits created and checked in (twice is one row)"

# Tomorrow in A's own zone (from /api/today), so this holds at any hour.
tomorrow=$(node -e 'const d=new Date(process.argv[1]+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+1);console.log(d.toISOString().slice(0,10))' "$today")
req "$JAR_A" PUT "/api/habits/$yes_id/check-ins/$tomorrow" '{}'; expect 400 "tomorrow's check-in"
req "$JAR_A" PATCH "/api/habits/$yes_id" "{\"updatedAt\":\"$yes_at\",\"name\":\"Read more\"}"; expect 200 "patch"
req "$JAR_A" PATCH "/api/habits/$yes_id" "{\"updatedAt\":\"$yes_at\",\"name\":\"Stale\"}"; expect 409 "stale patch"
pass "tomorrow is 400, stale update is 409"

req "$JAR_B" GET "/api/habits/$yes_id"; expect 404 "another user's habit (GET)"
req "$JAR_B" PATCH "/api/habits/$yes_id" "{\"updatedAt\":\"$yes_at\",\"name\":\"Mine\"}"; expect 404 "another user's habit (PATCH)"
req "$JAR_B" DELETE "/api/habits/$yes_id"; expect 404 "another user's habit (DELETE)"
req "$JAR_B" PUT "/api/habits/$yes_id/check-ins/$today" '{}'; expect 404 "another user's check-in"
req "$JAR_B" GET "/api/progress/heatmap?habitId=$yes_id"; expect 404 "another user's heatmap"
pass "another user gets 404 on the habit"

# The demo loader is admin-only: signed-out is 401, a plain user is 403, and nothing is created.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "origin: $BASE_URL" "$BASE_URL/api/admin/demo")
[ "$code" = "401" ] || fail "signed-out POST /api/admin/demo should be 401, got $code"
req "$JAR_A" POST /api/admin/demo; expect 403 "plain user loading the demo workspace"
pass "demo workspace loader is closed to signed-out and plain users"

req "$JAR_A" GET /api/progress/week; expect 200 "week summary"
echo "$BODY" | jq -e '(.week | test("^[0-9]{4}-W[0-9]{2}$")) and (.habits | length) == 2 and .totals.doneCheckIns == 2' >/dev/null || fail "week summary shape: $BODY"
week=$(echo "$BODY" | jq -r .week)
req "$JAR_A" GET "/api/progress/week?week=$week"; expect 200 "week round-trip"
echo "$BODY" | jq -e --arg w "$week" '.week == $w' >/dev/null || fail "week did not echo: $BODY"
req "$JAR_A" GET "/api/progress/week?week=2027-W53"; expect 400 "a week that doesn't exist"
req "$JAR_A" GET /api/progress/heatmap; expect 200 "heatmap"
echo "$BODY" | jq -e --arg t "$today" '(.days | length) == 30 and .to == $t and .days[-1].date == $t and .days[-1].done == 2 and .days[-1].total == 2 and ([.days[:-1][].done] | add) == 0' >/dev/null || fail "heatmap shape or counts: $BODY"
pass "week summary and heatmap"

# --- The weekly coach: live or demo (no model key), and a second call is served from the stored summary ---
req "$JAR_A" POST /api/coach '{}'; expect 200 "coach"
echo "$BODY" | jq -e '.week == "'"$week"'" and (.summary.mode | IN("live","demo")) and (.summary.generatedAt | type == "string") and (.summary.data | type == "object") and (.summary.stats | type == "object")' >/dev/null || fail "coach shape: $(printf '%s' "$BODY" | head -c 500)"
coach_at=$(echo "$BODY" | jq -r .summary.generatedAt); coach_mode=$(echo "$BODY" | jq -r .summary.mode)
req "$JAR_A" POST /api/coach '{}'; expect 200 "coach again"
echo "$BODY" | jq -e --arg at "$coach_at" '.cached == true and .summary.generatedAt == $at' >/dev/null || fail "second coach call should be cached with the same generatedAt: $(printf '%s' "$BODY" | head -c 500)"
req "$JAR_A" GET /api/coach; expect 200 "stored coach summary"
echo "$BODY" | jq -e --arg at "$coach_at" '.summary.generatedAt == $at' >/dev/null || fail "GET coach did not return the stored summary: $BODY"
req "$JAR_B" GET /api/coach; expect 200 "coach for B"
echo "$BODY" | jq -e '.summary == null' >/dev/null || fail "B sees a coach summary: $BODY"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{}' "$BASE_URL/api/coach")
[ "$code" = "401" ] || fail "signed-out POST /api/coach should be 401, got $code"
pass "coach summary (mode $coach_mode) is stored and not regenerated"

# --- Deleting a habit takes its check-ins with it ---
req "$JAR_A" DELETE "/api/habits/$yes_id"; expect 204 "delete habit"
req "$JAR_A" GET "/api/habits/$yes_id"; expect 404 "deleted habit"
req "$JAR_A" GET "/api/progress/heatmap?habitId=$yes_id"; expect 404 "deleted habit's heatmap"
req "$JAR_A" PUT "/api/habits/$yes_id/check-ins/$today" '{}'; expect 404 "check-in on a deleted habit"
req "$JAR_A" GET /api/today; expect 200 "today after delete"
echo "$BODY" | jq -e '(.habits | length) == 1 and ([.habits[] | select(.done)] | length) == 1' >/dev/null || fail "today after delete: $BODY"
req "$JAR_A" GET /api/progress/heatmap; expect 200 "heatmap after delete"
echo "$BODY" | jq -e '.days[-1].done == 1 and .days[-1].total == 1' >/dev/null || fail "the deleted habit's check-in is still counted: $BODY"
req "$JAR_A" GET /api/progress/week; expect 200 "week after delete"
echo "$BODY" | jq -e '.totals.doneCheckIns == 1' >/dev/null || fail "week still counts the deleted habit's check-in: $BODY"
pass "habit deleted and its check-ins are gone"

# --- Web push: service worker, manifest, config, subscriptions (never sends: a test push would reach a real service) ---
headers=$(curl -fsS -D - -o /dev/null "$BASE_URL/sw.js") || fail "/sw.js not served"
echo "$headers" | grep -qi '^content-type: application/javascript' || fail "/sw.js content type: $headers"
echo "$headers" | grep -qi '^cache-control: no-cache' || fail "/sw.js must be no-cache: $headers"
curl -fsS "$BASE_URL/sw.js" | grep -q 'addEventListener("push"' || fail "/sw.js has no push handler"
curl -fsS "$BASE_URL/sw.js" | grep -q 'addEventListener("fetch"' && fail "/sw.js must not have a fetch handler"
curl -fsS "$BASE_URL/manifest.webmanifest" | jq -e '.display == "standalone" and .start_url == "/today" and .short_name == "Habits" and (.icons | length) >= 3' >/dev/null || fail "manifest shape"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/push/config")
[ "$code" = "401" ] || fail "signed-out push config should be 401, got $code"
req "$JAR_A" GET /api/push/config; expect 200 "push config"
echo "$BODY" | jq -e '(.enabled | type == "boolean") and (keys | sort) == ["enabled","publicKey"]' >/dev/null || fail "push config shape (public key only): $BODY"
PUSH_ON=$(echo "$BODY" | jq -r .enabled)
if [ "$PUSH_ON" = "true" ]; then
  echo "$BODY" | jq -e '(.publicKey | length) == 87' >/dev/null || fail "push config public key: $BODY"
  curl -fsS "$BASE_URL/api/health" | jq -e '.push == "on"' >/dev/null || fail "health should report push on"
elif [ "$REQUIRE_PUSH" = "1" ]; then
  fail "push is not configured (enabled: false) but REQUIRE_PUSH=1"
else
  warn "push is not configured here; skipping the subscription checks"
fi

if [ "$PUSH_ON" = "true" ]; then
  sub=$(node -e 'const c=require("node:crypto");const e=c.createECDH("prime256v1");e.generateKeys();process.stdout.write(JSON.stringify({endpoint:"https://fcm.googleapis.com/fcm/send/smoke-"+Date.now(),keys:{p256dh:e.getPublicKey().toString("base64url"),auth:c.randomBytes(16).toString("base64url")}}))')
  req "$JAR_A" POST /api/push/subscriptions "$(echo "$sub" | jq -c '.endpoint="https://evil.example/x"')"; expect 400 "subscribe with a non-push host"
  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -X POST -H 'content-type: application/json' -H 'origin: https://evil.example' -d "$sub" "$BASE_URL/api/push/subscriptions")
  [ "$code" = "403" ] || fail "cross-origin subscribe should be 403, got $code"
  req "$JAR_A" POST /api/push/test; expect 400 "test push with no device"
  req "$JAR_A" POST /api/push/subscriptions "$sub"; expect 201 "subscribe"
  endpoint=$(echo "$sub" | jq -r .endpoint); PUSH_ENDPOINT=$endpoint
  req "$JAR_A" GET /api/push/subscriptions; expect 200 "list devices"
  echo "$BODY" | jq -e --arg e "$endpoint" '.devices | length == 1 and .[0].endpoint == $e' >/dev/null || fail "device list: $BODY"
  req "$JAR_B" GET /api/push/subscriptions; echo "$BODY" | jq -e '.devices | length == 0' >/dev/null || fail "another user sees devices: $BODY"
  req "$JAR_B" DELETE /api/push/subscriptions "{\"endpoint\":\"$endpoint\"}"; expect 404 "another user removing a device"
  req "$JAR_A" DELETE /api/push/subscriptions "{\"endpoint\":\"$endpoint\"}"; expect 204 "remove device"; PUSH_ENDPOINT=""
fi
pass "push: service worker, manifest, config, subscribe, remove"

req "$JAR_A" DELETE "/api/habits/$num_id"; expect 204 "delete the second habit"; HABITS=()
pass "run data cleaned up"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{}' "$BASE_URL/api/auth/sign-out")
[ "$code" = "200" ] || fail "sign-out should be 200, got $code"
pass "user signed out"

echo "SMOKE PASS"
