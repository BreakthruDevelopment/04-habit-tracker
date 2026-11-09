#!/usr/bin/env bash
# TEMPORARY diagnostic (branch claude/live-smoke-diag only; never merged).
set +e
echo "== board"; curl -sS -m 30 https://app1.breakthruventures.ai/api/board | jq -c '.. | objects | select(has("n") and has("status")) | {n, status, health: (.health // .lastHealth // null)}' 2>/dev/null | head -10
echo "== app 3"; curl -sS -m 30 https://app1.breakthruventures.ai/api/apps/3 | jq -c '{status: (.status // .app.status), history: ((.history // .app.history // [])[:4])}'
exit 1
