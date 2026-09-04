#!/bin/bash
# Build the suite bundle, compile it to wasm via the M1 pipeline, run under node.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"

"$here/build-suite.sh"

HERMES_SRC="$root/vendor/hermes" \
HOST_BUILD="$root/build/shermes-host" \
WASM_BUILD="$root/build/shermes-wasm" \
  "$root/spike/shermes-aot/compile.sh" "$here/suite-bundle.js"

echo "--- wasm suite under node"
rc=0
out=$(node "$here/suite-bundle-wasm.js" 2>&1) || rc=$?
echo "$out" | grep -E "^(PASS|FAIL|SKIP|RESULT|VERDICT)" || echo "$out"

if [ "$rc" -ne 0 ]; then
  echo "WASM-NODE VERDICT: RED (exit $rc)"
  exit 1
fi
if echo "$out" | grep -q "VERDICT: GREEN"; then
  echo "WASM-NODE VERDICT: GREEN"
  exit 0
fi
echo "WASM-NODE VERDICT: RED (no green verdict)"
exit 1
