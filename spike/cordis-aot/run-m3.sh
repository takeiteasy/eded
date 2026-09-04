#!/bin/bash
# M3 one-command runner: bundle real cordis, compile to wasm via the M1
# pipeline (now with -Xes6-block-scoping), run under node; then native.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
export HERMES_SRC="$root/vendor/hermes"
export HOST_BUILD="$root/build/shermes-host"
export WASM_BUILD="$root/build/shermes-wasm"

fail=0

echo "=== [1/3] esbuild bundle (es2017 IIFE) + node sanity"
"$here/bundle.sh" || fail=1

echo
echo "=== [2/3] wasm AOT (compile.sh) + node run"
"$root/spike/shermes-aot/compile.sh" "$here/cordis-bundle.js" >/dev/null
out=$(node "$here/cordis-bundle-wasm.js" 2>&1) || fail=1
echo "$out" | grep -E "^(PASS|FAIL|RESULT|VERDICT)" || echo "$out"
echo "$out" | grep -q "VERDICT: GREEN" || fail=1

echo
echo "=== [3/3] native shermes fast loop"
out=$("$HOST_BUILD/bin/shermes" -exec -Xenable-tdz -Xes6-block-scoping "$here/cordis-bundle.js" 2>&1)
rc=$?
echo "$out" | grep -E "^(PASS|FAIL|RESULT|VERDICT)" || echo "$out"
if [ "$rc" -ne 0 ]; then fail=1; fi
echo "$out" | grep -q "VERDICT: GREEN" || fail=1

echo
if [ "$fail" -eq 0 ]; then
  echo "M3 VERDICT: GREEN (node oracle + wasm-under-node + native)"
  exit 0
fi
echo "M3 VERDICT: RED"
exit 1
