#!/usr/bin/env bash
# TEMPORARY diagnostic (branch claude/live-smoke-diag only; never merged).
set +e
for n in 1 2 3 4; do
  H=app$n.breakthruventures.ai
  for t in 1 2 3; do
    echo "== $H attempt $t"; curl -sS -m 40 -w '\ncode=%{http_code} total=%{time_total}s connect=%{time_connect}s\n' https://$H/api/health; sleep 2
  done
done
echo "== app2 DNS"; dig +short app2.breakthruventures.ai CNAME; dig +short app2.breakthruventures.ai
exit 1
