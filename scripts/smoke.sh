#!/usr/bin/env bash
# TEMPORARY diagnostic (branch claude/live-smoke-diag only; never merged).
set +e
for t in 1 2 3; do echo "== app2 $t"; curl -sS -m 40 -w "\ncode=%{http_code} t=%{time_total}\n" https://app2.breakthruventures.ai/api/health; done
echo "== board"; curl -sS -m 30 https://app1.breakthruventures.ai/api/board | jq -c '.. | objects | select(has("n") and has("status")) | {n, status, health}' 2>/dev/null | head -6
exit 1
