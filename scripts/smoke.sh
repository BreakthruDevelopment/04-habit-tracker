#!/usr/bin/env bash
# End-to-end smoke test against a running app (local, CI, or a deployed URL).
# Checks health, the signed-out redirects, sign-up, and that signed-in users reach their pages while
# admin pages and admin-only auth endpoints stay closed. Issue 10 extends it with the habit flow.
#   BASE_URL=https://app7.breakthruventures.ai ./scripts/smoke.sh
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
RUN_ID="$(date +%s)$RANDOM"
JAR_A="$(mktemp)"; JAR_B="$(mktemp)"
trap 'rm -f "$JAR_A" "$JAR_B"' EXIT

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

health=$(curl -fsS "$BASE_URL/api/health") || fail "health endpoint unreachable"
echo "$health" | grep -q '"status":"ok"' || fail "health not ok: $health"
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

# --- The habit flow (issue 10 rewrites this into the full smoke test) ---
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
expect() { [ "$CODE" = "$1" ] || fail "$2: expected $1, got $CODE ($BODY)"; }

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
yes_id=$(echo "$BODY" | jq -r .habit.id); yes_at=$(echo "$BODY" | jq -r .habit.updatedAt)
req "$JAR_A" POST /api/habits '{"name":"Water","kind":"numeric","unit":"glasses","dailyTarget":"8"}'; expect 201 "create numeric habit"
num_id=$(echo "$BODY" | jq -r .habit.id)
req "$JAR_A" GET /api/today; expect 200 "today"
today=$(echo "$BODY" | jq -r .date)
[[ "$today" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || fail "today has no date: $BODY"

req "$JAR_A" PUT "/api/habits/$yes_id/check-ins/$today" '{}'; expect 200 "check in"
req "$JAR_A" PUT "/api/habits/$yes_id/check-ins/$today" '{}'; expect 200 "check in again"
req "$JAR_A" PUT "/api/habits/$num_id/check-ins/$today" '{"value":"8"}'; expect 200 "numeric check in"
req "$JAR_A" GET /api/today; expect 200 "today"
n=$(echo "$BODY" | jq '[.habits[] | select(.done)] | length'); [ "$n" = "2" ] || fail "expected 2 done habits, got $n"
pass "habits created and checked in (twice is one row)"

later=$(date -u -d '+2 days' +%F)
req "$JAR_A" PUT "/api/habits/$yes_id/check-ins/$later" '{}'; expect 400 "future check-in"
req "$JAR_A" PATCH "/api/habits/$yes_id" "{\"updatedAt\":\"$yes_at\",\"name\":\"Read more\"}"; expect 200 "patch"
req "$JAR_A" PATCH "/api/habits/$yes_id" "{\"updatedAt\":\"$yes_at\",\"name\":\"Stale\"}"; expect 409 "stale patch"
pass "future date is 400, stale update is 409"

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
echo "$BODY" | jq -e '(.days | length) == 30' >/dev/null || fail "heatmap should have 30 days"
pass "week summary and heatmap"

req "$JAR_A" DELETE "/api/habits/$yes_id"; expect 204 "delete habit"
req "$JAR_A" GET "/api/habits/$yes_id"; expect 404 "deleted habit"
pass "habit deleted"

# --- Web push: service worker, manifest, config, subscriptions (never sends: a test push would reach a real service) ---
headers=$(curl -fsS -D - -o /dev/null "$BASE_URL/sw.js") || fail "/sw.js not served"
echo "$headers" | grep -qi '^content-type: application/javascript' || fail "/sw.js content type: $headers"
echo "$headers" | grep -qi '^cache-control: no-cache' || fail "/sw.js must be no-cache: $headers"
curl -fsS "$BASE_URL/sw.js" | grep -q 'addEventListener("push"' || fail "/sw.js has no push handler"
curl -fsS "$BASE_URL/sw.js" | grep -q 'addEventListener("fetch"' && fail "/sw.js must not have a fetch handler"
curl -fsS "$BASE_URL/manifest.webmanifest" | jq -e '.display == "standalone" and .start_url == "/today" and .short_name == "Habits" and (.icons | length) >= 3' >/dev/null || fail "manifest shape"
curl -fsS "$BASE_URL/api/health" | jq -e '.push == "on"' >/dev/null || fail "health should report push on"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/push/config")
[ "$code" = "401" ] || fail "signed-out push config should be 401, got $code"
req "$JAR_A" GET /api/push/config; expect 200 "push config"
echo "$BODY" | jq -e '.enabled == true and (.publicKey | length) == 87 and (keys | sort) == ["enabled","publicKey"]' >/dev/null || fail "push config shape (public key only): $BODY"

sub=$(node -e 'const c=require("node:crypto");const e=c.createECDH("prime256v1");e.generateKeys();process.stdout.write(JSON.stringify({endpoint:"https://fcm.googleapis.com/fcm/send/smoke-"+Date.now(),keys:{p256dh:e.getPublicKey().toString("base64url"),auth:c.randomBytes(16).toString("base64url")}}))')
req "$JAR_A" POST /api/push/subscriptions "$(echo "$sub" | jq -c '.endpoint="https://evil.example/x"')"; expect 400 "subscribe with a non-push host"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_A" -X POST -H 'content-type: application/json' -H 'origin: https://evil.example' -d "$sub" "$BASE_URL/api/push/subscriptions")
[ "$code" = "403" ] || fail "cross-origin subscribe should be 403, got $code"
req "$JAR_A" POST /api/push/test; expect 400 "test push with no device"
req "$JAR_A" POST /api/push/subscriptions "$sub"; expect 201 "subscribe"
endpoint=$(echo "$sub" | jq -r .endpoint)
req "$JAR_A" GET /api/push/subscriptions; expect 200 "list devices"
echo "$BODY" | jq -e --arg e "$endpoint" '.devices | length == 1 and .[0].endpoint == $e' >/dev/null || fail "device list: $BODY"
req "$JAR_B" GET /api/push/subscriptions; echo "$BODY" | jq -e '.devices | length == 0' >/dev/null || fail "another user sees devices: $BODY"
req "$JAR_B" DELETE /api/push/subscriptions "{\"endpoint\":\"$endpoint\"}"; expect 404 "another user removing a device"
req "$JAR_A" DELETE /api/push/subscriptions "{\"endpoint\":\"$endpoint\"}"; expect 204 "remove device"
pass "push: service worker, manifest, config, subscribe, remove"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{}' "$BASE_URL/api/auth/sign-out")
[ "$code" = "200" ] || fail "sign-out should be 200, got $code"
pass "user signed out"

echo "SMOKE PASS"
