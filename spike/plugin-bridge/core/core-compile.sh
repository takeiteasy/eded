#!/bin/bash
# Build the M4 core module: cordis + bridge glue -> esbuild IIFE (es2017) ->
# shermes AOT -> emcc link with the core shim -> core-wasm.js/.wasm.
# MODULARIZE: the host gets a createCore() factory; no auto-run (no main).
#
# Usage: core-compile.sh
# Env:   HERMES_SRC / HOST_BUILD / WASM_BUILD
set -eu

HERMES_SRC="${HERMES_SRC:?set HERMES_SRC}"
HOST_BUILD="${HOST_BUILD:?set HOST_BUILD}"
WASM_BUILD="${WASM_BUILD:?set WASM_BUILD}"
export HermesSourcePath="$HERMES_SRC"

here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"

# 1) bundle cordis + entry (es2017 lowers async generators, M2/M3 finding)
./node_modules/.bin/esbuild core-entry.js \
    --bundle --format=iife --target=es2017 --platform=neutral \
    --outfile=core-bundle.js

# assert: no async generators survive the lowering (shermes rejects them)
if rg -n "async function\*" core-bundle.js >/dev/null 2>&1; then
  echo "FATAL: async function* survived esbuild lowering" >&2
  exit 1
fi

# 2) JS -> C (generated C exposes sh_export_this_unit)
"$HOST_BUILD/bin/shermes" -Xenable-tdz -Xes6-block-scoping -O -emit-c core-bundle.js

# 3) compile C + shim, link
emcc -O3 core-bundle.c -c \
    -DNDEBUG -fno-strict-aliasing -fno-strict-overflow \
    -I"$WASM_BUILD/lib/config" \
    -I"$HERMES_SRC/include"

emcc -O3 core-shim.cpp -c -std=c++17 \
    -DNDEBUG \
    -I"$WASM_BUILD/lib/config" \
    -I"$HERMES_SRC/include" \
    -I"$HERMES_SRC/API" \
    -I"$HERMES_SRC/API/jsi" \
    -I"$HERMES_SRC/public"

emcc -O3 core-bundle.o core-shim.o -o core-wasm.js \
    -sMODULARIZE=1 -sEXPORT_NAME=createCore \
    -L"$WASM_BUILD/lib" \
    -L"$WASM_BUILD/jsi" \
    -L"$WASM_BUILD/tools/shermes" \
    -lshermes_console_a -lhermesvm_a -ljsi \
    -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=256KB \
    -sEXPORTED_RUNTIME_METHODS=HEAPU8 \
    --no-entry \
    -sEXPORTED_FUNCTIONS=_core_init,_core_load_plugin,_core_unload_plugin,_core_call_service,_core_name_ptr,_core_name_len_set \
    --js-library "$here/../../shermes-aot/eded-random.js"

ls -lh core-wasm.*
