# FINDINGS — Static Hermes AOT spike

Working log for ticket #1 (spike milestones M1–M6). Each milestone records:
what was built, what broke, what was decided, and the numbers.

## M1 — toolchain (2026-09-04) : green

### What was built

- `vendor/hermes` — facebook/hermes `static_h` branch, git submodule, shallow,
  pinned at **`5cee10a`**.
- Two-stage build, both under `build/` (gitignored):
  - Stage 1 (host): `cmake -G Ninja -DCMAKE_BUILD_TYPE=Release` on
    `vendor/hermes`; targets `hermesc`, `hermes`, `shermes`.
  - Stage 2 (wasm): same source with
    `-DCMAKE_TOOLCHAIN_FILE=/opt/homebrew/Cellar/emscripten/6.0.2/libexec/cmake/Modules/Platform/Emscripten.cmake`
    `-DIMPORT_HOST_COMPILERS=build/shermes-host/ImportHostCompilers.cmake`
    `-DHAVE_SYS_IOCTL_H=0`
    `-DCMAKE_EXE_LINKER_FLAGS="-sNODERAWFS=1 -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=256KB"`;
    targets `hermes`, `shermes`, `shermes-dep`.
  - Note: the flag is `IMPORT_HOST_COMPILERS` (doc/Emscripten.md is
    authoritative); plan.md previously said `IMPORT_HERMESC` — corrected.
- `spike/shermes-aot/` — hello.js, `compile.sh` (eded's own pipeline wrapper),
  `eded-random.js` (link-time JS-library override), instrumented
  `index.html` browser host.

### Pipeline (proven)

```
wisp -> JS  ->  shermes -Xenable-tdz -emit-c   ->  .c
            ->  emcc -c (-O3, hermes include paths from wasm build)
            ->  emcc link against build/shermes-wasm static libs
                (-lshermes_console_a -lhermesvm_a -ljsi)
            ->  hello-wasm.js (glue) + hello-wasm.wasm
```

`spike/shermes-aot/compile.sh` wraps upstream `utils/wasm-compile.sh` and
relinks with `--js-library eded-random.js`. eded owns this script; upstream's
is treated as reference only.

### Verification

- **node 26**: `node hello-wasm.js` → expected output, **exit 0**.
- **browser (Arc/Chromium)**: served locally, instrumented host page shows
  `hello from eded, shermes-aot [core]` / `m1 ok` via `Module.print`.
  Arc has no usable headless mode; verification was visual (SSH sessions:
  expect to need a human or a CDP-capable browser for this step).

### Bugs hit and how they were fixed

1. **Host-function finalizer thread aborts at teardown** (both node and
   browser, output still correct). Root cause: every JSI HostFunction
   (even `console.log`) allocates an `HFContext` whose finalizer is deferred
   to `hermes::SerialExecutor`; under `__EMSCRIPTEN__` that executor spawns a
   `std::thread` lazily, which throws in single-threaded emscripten
   (noexcept-libc++ turns it into `abort()`).
   Fix: `patches/hermes-serial-executor-singlethread.patch` — under
   `__EMSCRIPTEN__` **without** `__EMSCRIPTEN_PTHREADS__`, `SerialExecutor::add`
   runs tasks inline. Finalizers are small and re-entrancy safe; threadState_
   stays Uninitialized so `~SerialExecutor` skips the join.
   Decision: keep the core **single-threaded**. Aligns with the sync-frame
   invariant and with Wasmtime (WASI preview1 has no threads). Rejected:
   `-sUSE_PTHREADS=1` (core would permanently require SharedArrayBuffer +
   COOP/COEP in browsers, pthread support in future hosts).
2. **`crypto.getRandomValues` rejects resizable views** (browser only; node
   unaffected — its backend is `crypto.randomBytes`). emscripten 6.0.2
   `libwasi.js` `$randomFill` passes a view into the (growable) wasm heap to
   WebCrypto, which throws on resizable-backed views. Upstream already routes
   around this for `SHARED_MEMORY` builds but not plain
   `ALLOW_MEMORY_GROWTH`. Fix: link-time override in
   `spike/shermes-aot/eded-random.js` — fill a non-resizable scratch buffer
   (chunked at WebCrypto's 64 KiB limit), copy in.
3. **Minified glue owns top-level `var out` / `var err`**: a host page that
   declares `const out` collides → SyntaxError kills the glue → blank page.
   Host-page identifiers must be namespaced (see `index.html`).

### Hermeneutics / corrections to plan.md

- `HERMES_UNICODE_LITE` is **optional** (for "pure" wasm hosts without the
  emscripten JS glue). M1 uses the default emscripten-glue path. Revisit when
  the Wasmtime/desktop rung decides its Unicode story (plan.md overstated it
  as a required flag).
- The wasm VM smoke test (`node build/shermes-wasm/bin/hermes.js hello.js`)
  also exits clean now — fix 1 covers the interpreter path too.
- Native `shermes` has no `-eval` flag; feed it files (`-Xenable-tdz` is the
  flag upstream's pipeline uses).

### Numbers (M1)

- `hello-wasm.wasm`: **3.2 MB** at `-O3`, unstripped, full VM+compiler linked.
  (A lean/MinSizeRel build and `emstrip`/debug-stripping are unmeasured —
  real size accounting happens at M6.)
- Glue JS: 72 KB.
- Module contains the entire shermes runtime per upstream design; AOT-compiled
  JS sits beside it as generated C.

### Carried to M2

- Kill-test probes go through the same `compile.sh` (Proxy traps, WeakRef,
  async/await, class static blocks, private fields). Mini cordis-shaped
  Context first, then real cordis.
- If M2 needs pthreads for some reason, the decision above gets revisited —
  the patch is scoped by `!__EMSCRIPTEN_PTHREADS__` so a pthreads rebuild is
  still possible without touching the patch.
