#!/usr/bin/env bash
# End-to-end smoke test against a running app (local, CI, or a deployed URL).
# Signs up two users over HTTP and proves one can't delete the other's item.
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

for path in /dashboard /admin; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL$path")
  [ "$code" = "307" ] || fail "signed-out $path should redirect (307), got $code"
done
pass "signed-out dashboard and admin redirect"

signup() {
  local jar=$1 email=$2
  curl -fsS -c "$jar" -b "$jar" -H 'content-type: application/json' -H "origin: $BASE_URL" \
    -d "{\"email\":\"$email\",\"password\":\"smoke-test-password-1\",\"name\":\"Smoke\"}" \
    "$BASE_URL/api/auth/sign-up/email" >/dev/null || fail "sign-up failed for $email"
}

signup "$JAR_A" "smoke-a-$RUN_ID@example.test"
signup "$JAR_B" "smoke-b-$RUN_ID@example.test"
pass "two users signed up"

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/items")
[ "$code" = "401" ] || fail "anonymous list should be 401, got $code"
pass "anonymous access refused"

item=$(curl -fsS -b "$JAR_A" -H 'content-type: application/json' -H "origin: $BASE_URL" \
  -d '{"title":"smoke item"}' "$BASE_URL/api/items") || fail "create item failed"
id=$(echo "$item" | sed -E 's/.*"id":"([^"]+)".*/\1/')
[ -n "$id" ] || fail "no item id in $item"
pass "user A created an item"

code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -b "$JAR_B" -H "origin: $BASE_URL" "$BASE_URL/api/items/$id")
[ "$code" = "403" ] || fail "user B deleting A's item should be 403, got $code"
pass "user B blocked from A's item"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -b "$JAR_A" -H "origin: $BASE_URL" "$BASE_URL/api/ai/summarize")
[ "$code" = "200" ] || fail "AI summary should be 200, got $code"
pass "AI summary responds"

code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -b "$JAR_A" -H "origin: $BASE_URL" "$BASE_URL/api/items/$id")
[ "$code" = "204" ] || fail "owner delete should be 204, got $code"
pass "owner deleted their item"

echo "SMOKE PASS"
