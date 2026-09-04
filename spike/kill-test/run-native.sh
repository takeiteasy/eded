#!/bin/bash
# Run every probe natively: shermes -exec -Xenable-tdz (fast dev loop).
set -u
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
SHERMES="${SHERMES:-$root/build/shermes-host/bin/shermes}"

fails=0
total=0
for p in "$here"/probes/*.js; do
  total=$((total + 1))
  out=$(timeout 60 "$SHERMES" -exec -Xenable-tdz "$p" 2>&1)
  rc=$?
  echo "--- $(basename "$p") (exit $rc)"
  echo "$out" | grep -E "^(PASS|FAIL|SKIP|RESULT)" || echo "(no probe output)"
  n=$(echo "$out" | grep -c "^FAIL" || true)
  # a probe that never prints RESULT died early (e.g. swallowed unhandled rejection)
  r=$(echo "$out" | grep -c "^RESULT" || true)
  if [ "$rc" -ne 0 ] || [ "$n" -gt 0 ] || [ "$r" -eq 0 ]; then fails=$((fails + 1)); fi
done

echo
if [ "$fails" -eq 0 ]; then
  echo "NATIVE VERDICT: GREEN ($total probes)"
  exit 0
else
  echo "NATIVE VERDICT: RED ($fails/$total probes failing)"
  exit 1
fi
