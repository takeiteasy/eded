#!/bin/bash
# eded's JS -> wasm pipeline (M1; M3 adds -Xes6-block-scoping).
# Owns the full shermes -> emcc flow; upstream utils/wasm-compile.sh is
# reference only (it hardcodes shermes flags, so the scoping flag cannot be
# passed through it).
#
# Env:
#   HERMES_SRC  path to the static_h checkout (vendor/hermes)
#   HOST_BUILD  native two-stage build dir (build/shermes-host)
#   WASM_BUILD  emscripten build dir       (build/shermes-wasm)
# Usage:
#   compile.sh <file.js>   (artifacts land next to the input)
#
# Flags (see FINDINGS.md M3):
#   -Xenable-tdz          let/const temporal dead zone checks
#   -Xes6-block-scoping   ES6 block scoping: per-iteration loop environments.
#                         WITHOUT THIS, closures capturing for/while-scoped
#                         let/const share ONE binding across iterations
#                         (last value wins) — silent spec violation, hits
#                         both native and wasm, interpreter included.
set -eu

HERMES_SRC="${HERMES_SRC:?set HERMES_SRC}"
HOST_BUILD="${HOST_BUILD:?set HOST_BUILD}"
WASM_BUILD="${WASM_BUILD:?set WASM_BUILD}"
export HermesSourcePath="$HERMES_SRC"

here="$(cd "$(dirname "$0")" && pwd)"
file="${1:?usage: compile.sh <file.js>}"
name="$(basename "${file%.*}")"
# shermes -emit-c and emcc write outputs relative to the working directory;
# pin everything to the input's dir
input_dir="$(cd "$(dirname "$file")" && pwd)"
file="$input_dir/$(basename "$file")"
cd "$input_dir"

SHERMES_FLAGS=(-Xenable-tdz -Xes6-block-scoping)

"$HOST_BUILD/bin/shermes" "${SHERMES_FLAGS[@]}" -emit-c "$file"

emcc "$name.c" -c \
    -O3 \
    -DNDEBUG \
    -fno-strict-aliasing -fno-strict-overflow \
    -I"$WASM_BUILD/lib/config" \
    -I"$HERMES_SRC/include"

# Relink with eded's overrides (see eded-random.js: upstream randomFill
# aborts in browsers because WebCrypto rejects resizable heap views).
emcc -O3 "$name.o" -o "$name-wasm.js" \
    -L"$WASM_BUILD/lib" \
    -L"$WASM_BUILD/jsi" \
    -L"$WASM_BUILD/tools/shermes" \
    -lshermes_console_a -lhermesvm_a -ljsi \
    -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=256KB \
    --js-library "$here/eded-random.js"

ls -lh "$input_dir/$name-wasm".*
