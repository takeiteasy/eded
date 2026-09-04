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

## M3 — cordis AOT end to end (2026-09-04) : GREEN (one pipeline-level discovery)

### What was built

- `spike/cordis-aot/` — real `@deepseek-ai/cordis@4.0.2` (exact pin, plus
  cosmokit transitively) compiled AOT and driven through a full lifecycle
  suite. Own `package.json` pins `esbuild@0.25.12`; `type: commonjs`
  deliberately — the emscripten glue is CJS and node loads `*-wasm.js`
  directly (ESM package type breaks it; the harness is `lifecycle.mjs`).
- `lifecycle.mjs` — 6 probes over real cordis, M2 output contract
  (`PASS|FAIL`, `RESULT`, `VERDICT`, exit code = failures):
  p1 provide/inject across `extend()` + inject-miss deferral, p2 real
  `Service` subclass (callable through `ctx.counter` + inject), p3 sync
  effect + teardown-on-unload, p4 async body/async disposer ordering, p5
  plugin with `inject` deps (not started before provide, start → dispose
  ordering), p6 `isConstructor` pitfall (named function + `.prototype`
  drops returned disposer; `ctx.effect` teardown still runs).
- `bundle.sh` — `esbuild lifecycle.mjs --bundle --format=iife
  --target=es2017 --platform=neutral` + asserts (no `async function*`
  survives; `__asyncGenerator` helper present) + bare-bundle node run.
- `run-m3.sh` — one command: bundle → AOT wasm → node, then native shermes.
- `probe-loop-scoping.js` — permanent semantics probe for the discovery
  below; re-run after any hermes re-pin or toolchain change.
- `index.html` — browser host (namespaced ids, `onerror` +
  `onunhandledrejection`, verdict check).

### THE discovery: `-Xes6-block-scoping` is mandatory

Cordis under the M2 pipeline (no extra flags) failed natively with
`invalid plugin, expect function or object with an "apply" method` and
`Object is not a function` in the fiber apply path — while node ran the
identical bundle green. Bisect chain (instrumented bundle → pure-shermes
probes): `ctx.inject(["a"], cb)` reached `registry.plugin()` with the **deps
array** as the plugin argument. Root cause far below cordis:

> **static_h compiles legacy ES5 scoping by default. Closures capturing
> loop-scoped `let`/`const` share ONE binding across iterations — every
> closure sees the final value.** Broken for `for (let i …)` (arrow AND
> function-expression capture), `for…of`/`for…in` (destructuring or not),
> `while` with an inner `const`, and under the interpreter (`hermes -exec`)
> as well as native/wasm AOT — it is the shared frontend, not the AOT
> backend. `var` semantics (share) are correct; non-loop closures are
> correct. Spec violation, silent, no warning.

Fix: **`-Xes6-block-scoping`** (undocumented — absent from `shermes -help`,
referenced only by old HBC-era lit tests like `test/IRGen/es6/
for-let-tdz.js`) restores spec-correct per-iteration environments on all
rungs. Not a hermes bug to report — a default-off scoping mode.

Consequences:

- cordis's `ReflectService.mixin()` wires `ctx.inject`/`ctx.plugin` via
  accessors created in a `for (const [key, value] of …)` loop inside a
  generator — with legacy scoping every accessor captured the last key, so
  `ctx.inject` returned `ctx.plugin`. The ES2017-lowered bundle preserved
  the pattern (esbuild keeps `for…of`/shorthands; only async generators and
  newer syntax lower), which is why M2's hand-written probes never saw it:
  **M2's 11 probes contained zero loop-variable captures.** The M2 GREEN
  verdict stands for what it tested, but was blind to this class.
- `spike/shermes-aot/compile.sh` now owns the whole pipeline (upstream
  `utils/wasm-compile.sh` hardcodes shermes flags and can't take the flag)
  and bakes in `-Xenable-tdz -Xes6-block-scoping`. M2 suite re-run under the
  new pipeline: still GREEN 11/11.
- Any plugin-module JS with closures in loops needs the same flag — it is
  in the shared `compile.sh`, so all rungs and all JS producers inherit it.

Debugging notes worth keeping: `JSON.stringify` silently omits function
values — it "hid" the `apply` property mid-bisect and nearly misdirected to
a property-dropping bug; instrument with `typeof` + `Object.keys`, not
JSON. Native shermes has no `quit()` (`typeof quit === "function"` guards
it; exit codes only work under wasm/node glue) — RESULT lines remain the
only trustworthy native signal, as M2 already concluded.

### Verification

- `run-m3.sh`: **GREEN on all four rungs** — node oracle (uncompiled ESM),
  es2017 IIFE bundle under node, wasm AOT under node (exit 0), native
  `shermes -exec`, and the browser host (visually confirmed 2026-09-04:
  six PASS/RESULT lines + `VERDICT: GREEN`, wasm served with
  content-type `application/wasm`). Zero semantic divergences between the
  AOT module and node 26 on the full lifecycle surface.
- `AsyncGeneratorFunction` after es2017 lowering resolves to
  `GeneratorFunction` (the `__asyncGenerator` wrapper is a sync generator
  function). cordis's `isConstructor` generator exclusion therefore widens
  to cover sync generators too — self-consistent within the bundle
  (nothing in it is a native async generator anymore) and harmless:
  generator functions were never plugin-shaped. Recorded, not fixed.

### Numbers (M3)

- cordis-bundle.js (es2017 IIFE, cordis + cosmokit + harness): **79.4 kB**
  (raw cordis ESM reference: 69 kB; ~10 kB is the async-generator lowering
  machinery).
- `cordis-bundle-wasm.wasm`: **4.0 MB** `-O3` unstripped (M1 hello 3.2 MB →
  +0.8 MB for full cordis + suite).
- `repro-loop-matrix-wasm.wasm`: 3.2 MB (matrix probe alone, bare runtime).
- esbuild bundle: ~11 ms; hermesc → C → emcc → wasm: seconds.

### Carried to M4

- **Plugin model decided 2026-09-04: B2 — a plugin is a wasm module.** No
  eval path in the core; cordis stays in-core and plugins are ABI clients
  (the core wraps each bridged plugin as an arrow function, dodging the
  isConstructor gotcha). M4 is therefore the bridge spike: one real plugin
  module (shermes-JS and/or C toy) across a v0 host-mediated ABI, plus the
  per-plugin module-size measurement — every shermes-JS module carries its
  own runtime (~3.2 MB pre-plugin-code at M3 flags); that number decides
  whether size engineering (-Os, strip, brotli, lazy instantiate) becomes
  M6 work.
- The AOT path needs `-Xes6-block-scoping` everywhere JS is compiled (core
  AND plugin modules). It lives in `compile.sh`, so every JS producer
  inherits it automatically; authoring tools that merely emit JS need no
  knowledge of it.
- Keep `probe-loop-scoping.js` in the re-verification checklist for any
  hermes pin bump.
