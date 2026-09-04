#!/bin/bash
# M4 one-command runner: rebuild plugins + core, run the host harness under
# node. Browser rung: serve spike/plugin-bridge/ and open index.html (the
# node rung is the primary; browser verification is visual).
set -u
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
export HERMES_SRC="$root/vendor/hermes"
export HOST_BUILD="$root/build/shermes-host"
export WASM_BUILD="$root/build/shermes-wasm"

fail=0

echo "=== [1/3] C toy plugin (freestanding wasm)"
(cd "$here" && clang --target=wasm32 -Oz -nostdlib \
    -Wl,--no-entry -Wl,--export=plugin_init -Wl,--export=plugin_call \
    -Wl,--export=plugin_dispose -Wl,--strip-all -o toy.wasm toy.c) || fail=1

echo
echo "=== [2/3] shermes-JS plugin (counter toy)"
"$here/compile-plugin.sh" "$here/plugin-counter.js" >/dev/null || fail=1

echo
echo "=== [3/3] core (cordis + bridge) + host harness"
"$here/core/core-compile.sh" >/dev/null || fail=1
out=$(node "$here/host.mjs" 2>&1) || fail=1
echo "$out" | grep -E "^(PASS|FAIL|NUMBERS|RESULT|VERDICT)" || echo "$out"
echo "$out" | grep -q "VERDICT: GREEN" || fail=1

echo
if [ "$fail" -eq 0 ]; then
  echo "M4 VERDICT: GREEN (node host rung)"
  echo "Browser rung: serve this dir (http.server) and open index.html."
  exit 0
fi
echo "M4 VERDICT: RED"
exit 1
