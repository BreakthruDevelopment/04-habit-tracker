#!/usr/bin/env bash
# TEMPORARY diagnostic (branch claude/live-smoke-diag only; never merged).
set +e
echo "== tracker"; curl -sS -m 30 https://app1.breakthruventures.ai/api/health; echo
curl -sS -m 30 https://app1.breakthruventures.ai/api/board | jq -c '.. | objects | select(has("n") and has("status")) | select(.n<=4) | {n,status,running,health,healthAt}' 2>/dev/null
exit 1
