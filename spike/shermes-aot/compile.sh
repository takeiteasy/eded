#!/bin/bash
# eded's JS -> wasm pipeline (M1). Wraps upstream utils/wasm-compile.sh and
# relinks with eded's JS-library overrides.
#
# Env:
#   HERMES_SRC  path to the static_h checkout (vendor/hermes)
#   HOST_BUILD  native two-stage build dir (build/shermes-host)
#   WASM_BUILD  emscripten build dir       (build/shermes-wasm)
# Usage:
#   compile.sh <file.js>   (artifacts land next to the input)
set -eu

HERMES_SRC="${HERMES_SRC:?set HERMES_SRC}"
HOST_BUILD="${HOST_BUILD:?set HOST_BUILD}"
WASM_BUILD="${WASM_BUILD:?set WASM_BUILD}"
export HermesSourcePath="$HERMES_SRC"

here="$(cd "$(dirname "$0")" && pwd)"
file="${1:?usage: compile.sh <file.js>}"
name="$(basename "${file%.*}")"

"$HERMES_SRC/utils/wasm-compile.sh" "$HOST_BUILD" "$WASM_BUILD" "$file"

# Relink with eded's overrides (see eded-random.js: upstream randomFill
# aborts in browsers because WebCrypto rejects resizable heap views).
emcc -O3 "$name.o" -o "$name-wasm.js" \
    -L"$WASM_BUILD/lib" \
    -L"$WASM_BUILD/jsi" \
    -L"$WASM_BUILD/tools/shermes" \
    -lshermes_console_a -lhermesvm_a -ljsi \
    -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=256KB \
    --js-library "$here/eded-random.js"

ls -lh "$name-wasm".*
