#!/usr/bin/env bash
# TEMPORARY diagnostic for the app 4 Oracle deploy (branch claude/live-smoke-diag only; never merged).
set +e
H=app4.breakthruventures.ai
echo "== DNS"; dig +short A $H; dig +short A $H @1.1.1.1
IP=$(dig +short A $H @1.1.1.1 | tail -1); echo "IP=$IP"
echo "== TLS/health via domain"; curl -sS -m 20 -o /dev/null -w 'code=%{http_code} ssl_verify=%{ssl_verify_result}\n' https://$H/api/health; curl -sS -m 20 https://$H/api/health; echo
echo "== curl -v (head)"; curl -sv -m 20 https://$H/api/health 2>&1 | grep -E '^\*|^< HTTP' | head -25
if [ -n "$IP" ]; then
  S=habit-tracker.${IP//./-}.sslip.io
  echo "== sslip $S"; curl -sS -m 20 -w '\ncode=%{http_code}\n' https://$S/api/health
  for a in template; do T=$a.${IP//./-}.sslip.io; echo "== $T"; curl -sS -m 20 -w '\ncode=%{http_code}\n' https://$T/api/health; done
  echo "== plain http"; curl -sS -m 10 -o /dev/null -w 'code=%{http_code}\n' -H "Host: $H" http://$IP/
fi
exit 1
