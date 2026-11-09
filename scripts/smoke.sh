#!/usr/bin/env bash
# TEMPORARY diagnostic (branch claude/live-smoke-diag only; never merged).
set +e
echo "== tracker health"; curl -sS -m 30 https://app1.breakthruventures.ai/api/health; echo
echo "== board"; curl -sS -m 30 https://app1.breakthruventures.ai/api/board | jq -c '.. | objects | select(has("n") and has("status")) | {n, status, health}' 2>/dev/null | head -6
exit 1
