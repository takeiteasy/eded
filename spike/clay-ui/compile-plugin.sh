#!/bin/bash
# Compile a JS plugin (JS -> shermes AOT -> wasm plugin module) for M4.
# Difference from ../shermes-aot/compile.sh: -exported-unit (no generated
# main; the js-plugin.cpp shim provides the wasm exports and lazily
# initializes the SH runtime), --no-entry.
#
# Usage: compile-plugin.sh <file.js>            (artifacts land next to input)
# Env:   HERMES_SRC / HOST_BUILD / WASM_BUILD   (same as compile.sh)
set -eu

HERMES_SRC="${HERMES_SRC:?set HERMES_SRC}"
HOST_BUILD="${HOST_BUILD:?set HOST_BUILD}"
WASM_BUILD="${WASM_BUILD:?set WASM_BUILD}"
export HermesSourcePath="$HERMES_SRC"

here="$(cd "$(dirname "$0")" && pwd)"
file="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
name="$(basename "${file%.*}")"
cd "$(dirname "$file")"

SHERMES_FLAGS=(-Xenable-tdz -Xes6-block-scoping -O -exported-unit=eded_plugin)

# 1) JS -> C (SHUnit export; no main generated; output lands in the CWD)
"$HOST_BUILD/bin/shermes" "${SHERMES_FLAGS[@]}" -emit-c "$file"

# 2) C -> wasm, linking the JS-plugin shim; exports are the v0 contract
emcc -O3 "$name.c" -c \
    -DNDEBUG -fno-strict-aliasing -fno-strict-overflow \
    -I"$WASM_BUILD/lib/config" \
    -I"$HERMES_SRC/include" \
    -I"$HERMES_SRC/API"

emcc -O3 "$here/js-plugin.cpp" -c -std=c++17 \
    -DNDEBUG \
    -I"$WASM_BUILD/lib/config" \
    -I"$HERMES_SRC/include" \
    -I"$HERMES_SRC/API" \
    -I"$HERMES_SRC/API/jsi" \
    -I"$HERMES_SRC/public"

emcc -O3 "$name.o" js-plugin.o -o "$name-wasm.js" \
    -sMODULARIZE=1 -sEXPORT_NAME=createPluginModule \
    -L"$WASM_BUILD/lib" \
    -L"$WASM_BUILD/jsi" \
    -L"$WASM_BUILD/tools/shermes" \
    -lshermes_console_a -lhermesvm_a -ljsi \
    -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=256KB \
    -sEXPORTED_RUNTIME_METHODS=HEAPU8 \
    --no-entry \
    -sEXPORTED_FUNCTIONS=_plugin_init,_plugin_call,_plugin_dispose \
    --js-library "$here/../shermes-aot/eded-random.js"

ls -lh "$name-wasm".*
