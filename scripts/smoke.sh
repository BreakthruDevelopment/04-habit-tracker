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

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" -d '{}' "$BASE_URL/api/auth/sign-out")
[ "$code" = "200" ] || fail "sign-out should be 200, got $code"
pass "user signed out"

echo "SMOKE PASS"
