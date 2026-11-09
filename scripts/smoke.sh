#!/usr/bin/env bash
# TEMPORARY diagnostic (branch claude/live-smoke-diag only; never merged).
set +e
echo "== board"; curl -sS -m 30 https://app1.breakthruventures.ai/api/board | jq -c '.. | objects | select(has("n") and has("status")) | select(.n<=4) | with_entries(select(.key|test("^(n|status|health)$|At$|checked|ms";"i")))' 2>/dev/null
exit 1
