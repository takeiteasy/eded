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
- Native `shermes` executes with **`-exec`** (`shermes -exec -Xenable-tdz
  file.js`); without it the driver only compiles. Native linking needs the
  console libs built explicitly (`ninja -C build/shermes-host
  shermes_console_a shermes_console`) — not part of the default target set.

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

## M2 — kill-test (2026-09-04) : GREEN (one compile-level caveat)

### What was built

- `spike/kill-test/` — cordis-grounded probe suite (11 probes, `probes/p01…p11`),
  each self-contained JS printing `PASS|FAIL|SKIP name — detail` + `RESULT`,
  exit code = failure count. Probes derived from an actual source skim of
  `@deepseek-ai/cordis@4.0.2` (`node_modules` local, gitignored; version
  pinned by `spike/kill-test/package.json`).
- `run-native.sh` (per-probe `shermes -exec -Xenable-tdz`, fast loop),
  `build-suite.sh` (concatenates probes in IIFEs + a shared reporter — one
  wasm module for all probes), `run-wasm.sh` (M1 pipeline → node),
  `index.html` (browser host, verdict line). `preflight.js` documents
  drain semantics.

### Verdict

**GREEN on all three rungs**: native (11/11), wasm under node (11/11),
browser (visually confirmed via console verdict line). Only SKIP: async
generators (below). **Zero semantic divergences found between shermes AOT
(native or wasm) and node 26** — every probe discrepancy during development
was a probe bug, and node always failed identically when one existed.

### The caveat: async generators are a compile-level rejection

`shermes` rejects `async function*` at compile time (preflight + p05). This
matters because the cordis bundle **contains one**
(`AsyncGeneratorFunction = async function*(){}.constructor`). Not a semantic
kill: the M3 pipeline mitigates by bundling with
`esbuild --target=es2017`, which lowers async generators to sync generators
+ promise state machines (both proven green here). Sync generators,
async/await, custom thenables and Promise combinators are all green.

### What was proven (cordis's load-bearing surface)

- **Proxy**: shared handler objects (get/set/has), receiver plumbing through
  `Reflect.get(target, prop, receiver)`, throwing traps, `in`/`has`, symbol
  props through traps, `Object.create(proxy)` prototype chains (trap
  fallthrough through inheritance, two hops), apply-trap proxies over
  functions, prototype-swapped callables. One **receiver-vs-target subtlety**
  surfaced: a trap's `target` is always the root's backing object, so
  per-child state must be resolved via the receiver — cordis's fiber walk
  does exactly this.
- **Callable objects**: cordis's `createCallable` shape requires
  `Function.prototype` kept in the swapped prototype chain (that is what
  `joinPrototype(proto, Function.prototype)` is for) — otherwise `.bind`
  vanish. Proven both ways.
- **Classes**: bare instance fields, static fields, static blocks writing
  symbol-keyed prototype props, getters/setters, constructor returning an
  object, `static [Symbol.hasInstance]` prototype walks (note: the walk
  misses the class itself — `.constructor` is `Function` — matching cordis,
  which only classifies instances), class expressions, `extends`/`super`.
- **async**: chains, `Promise.all`/`allSettled`, rejection propagation,
  microtask ordering (native drains at exit — output order matches node),
  custom thenables (`wrapper.then = async …`, cordis's effect wrapper),
  thenable-through-Promise chaining.
- **Weak collections**: DisposableList shape (Map order + WeakMap reverse
  lookup, `clear()` reverses), Map insertion-order/re-insert semantics,
  WeakRef deref-while-held, FinalizationRegistry construct+register. GC
  timing is not asserted anywhere — Hermes uses conservative stack scanning,
  so unreachable-but-on-stack objects may survive collection (engine
  property, not an AOT defect). WeakMap accepts symbol keys (ES2023) — the
  mini-Context store relies on it.
- **Errors**: subclassing + instanceof, `Error.stack` string surgery
  (split/splice/Infinity/join, frame `endsWith`), prototype brand markers.
- **Private fields** (#field/#method/static/#in, brand collisions) — green,
  though cordis itself uses none.
- **Mini cordis-shaped Context (p11)**: provide/inject through the proxy,
  `extend()` via `Object.create(proxy)` + descriptor defines, `isolate()`
  label shadows, effects with sync/async bodies and sync/async disposers,
  `start()` = Promise.all, `dispose()` = reversed clear + awaited disposers,
  service unload after dispose, inject-miss throws the cordis-shaped error.
  Full lifecycle green on all rungs.

### New native/driver findings

- **`-exec` is the native execution flag** (corrects M1's note above);
  `shermes file.js` alone only compiles.
- Native linking needs `shermes_console_a`/`shermes_console` built
  explicitly; they are not in the default target set.
- **Native shermes swallows unhandled promise rejections silently (exit 0)**.
  Node 26 makes them fatal. The native runner therefore requires a `RESULT`
  line per probe (silence ≠ pass). Browser hosts must hook
  `onunhandledrejection` (M1's instrumented page already does; carry to M5).
- `spike/shermes-aot/compile.sh` is now CWD-independent (it `cd`s to the
  input's directory — upstream `wasm-compile.sh` and emcc write outputs
  relative to the working directory, not the input path).

### Numbers (M2)

- Suite module: **3.8 MB** wasm (`-O3`, unstripped) vs 3.2 MB for M1 hello —
  the whole 11-probe suite costs +0.6 MB over the bare runtime.
- Native per-probe compile+run: sub-second (fast dev loop confirmed).
- cordis reference: 4.0.2, 1828-line ESM bundle.

### Carried to M3

- Bundle real cordis with `esbuild --target=es2017` (async-generator
  lowering) — validate the `AsyncGeneratorFunction` line compiles lowered.
- Keep `-Xenable-tdz`; the IIFE-concatenation pattern is proven if a single
  module ever needs multiple sources.
- `isConstructor` heuristic (`.prototype` + GeneratorFunction exclusion)
  proven — wisp2's `defplugin` arrow-plugin guidance stands.
