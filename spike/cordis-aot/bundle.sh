#!/bin/bash
# M3: bundle lifecycle.js + real cordis into one IIFE for the AOT pipeline.
# --target=es2017 lowers the bundle's async generators (shermes rejects
# async function* at compile time; see M2 findings).
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/cordis-bundle.js"

(cd "$here" && npx esbuild lifecycle.mjs \
  --bundle --format=iife --target=es2017 --platform=neutral \
  --outfile="$out")

# sanity: the async-generator lowering must be present and no source form left
if grep -q "async function\*" "$out"; then
  echo "BUNDLE CHECK FAILED: async function* survived lowering" >&2
  exit 1
fi
if ! grep -q "__asyncGenerator" "$out"; then
  echo "BUNDLE CHECK FAILED: __asyncGenerator helper missing" >&2
  exit 1
fi

echo "--- bundle sanity under node"
node "$out"
echo "BUNDLE OK: node exit 0"
