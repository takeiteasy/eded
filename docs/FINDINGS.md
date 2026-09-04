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

## M4 — plugin bridge (2026-09-04) : GREEN (node host rung; browser prepared)

### What was built

- `spike/plugin-bridge/` — the host-mediated bridge spike (M4 = ticket #4's
  scope, executed under ticket #1 per the M4 re-point). A **plugin is a wasm
  module**: the host instantiates it, keeps a `handle → instance` table, and
  routes calls between it and the in-core cordis.
- **v0 plugin contract** (sync, integers, negative = error; WIT-transcribable
  by design — see Decisions):
  - plugin module exports: `plugin_init() -> i32`,
    `plugin_call(fn, a, b) -> i32`, `plugin_dispose() -> i32`
  - core exports (host calls): `core_init`, `core_load_plugin(handle)`,
    `core_unload_plugin(handle)`, `core_call_service(fn, a, b)` (spike
    consumer surface), `core_name_ptr` + `core_name_len_set` (scratch buffer)
  - core imports (host-implemented, routed by handle):
    `host_plugin_call(handle, fn, a, b) -> i32`,
    `host_plugin_dispose(handle) -> i32`
- Two plugin modules on the same contract:
  - `plugin-counter.js` — shermes-JS toy, compiled by
    `compile-plugin.sh` (the M3 pipeline + `js-plugin.cpp` shim). The plugin
    JS registers `eded_init`/`eded_call`/`eded_dispose` on globalThis at
    unit-init; the shim forwards the wasm exports to them.
  - `toy.c` — pure freestanding C (`clang --target=wasm32 -nostdlib
    --no-entry`), **241 bytes**, no runtime, no imports.
- `core/` — the core module: real cordis 4.0.2 + bridge glue (`core-entry.js`)
  AOT-compiled and linked with `core-shim.cpp`. Each bridged plugin is wrapped
  as an **arrow-function** cordis plugin (isConstructor-safe, M3 p6) whose
  body `local.provide(name, {call})` routes through the bridge, with an
  `effect()` disposer calling `plugin_dispose` via the host. A node oracle
  (`core/core-oracle.mjs`, 8/8) pinned the cordis semantics the bridge relies
  on BEFORE AOT: provide-from-plugin-body is visible to outside inject; fiber
  start is a microtask (not synchronous with `ctx.plugin()`); after
  `fiber.dispose()` a fresh inject of the name defers again; arrow wrappers
  tear down via `ctx.effect` normally.
- `host.mjs` — the host harness (node rung): instantiates core + plugins,
  owns the bridge table (`globalThis.__ededHost`), runs the probe suite.
  `index.html` — browser twin of the same logic (verdict on page + console).

### Key discoveries

1. **The JSI escape hatch is the real shim API.** `_sh_get_hermes_runtime(shr)`
   returns a full `facebook::hermes::HermesRuntime` (jsi::Runtime) for the SH
   runtime — the same mechanism the console bindings use. With it, shims are
   plain JSI: `global().setProperty` + `Function::createFromHostFunction` for
   the JS→C direction (core imports), `getPropertyAsFunction(...).call(...)`
   for C→JS, `String::createFromUtf8` for strings, `drainMicrotasks()` for
   the job queue. No raw frame poking needed. (The raw SH convention is
   decoded below for the record.)
2. **SH C→JS calling convention** (decoded from SH.cpp codegen, for cases
   where JSI is unavailable): the caller pushes a 12-register outgoing
   region; `frame[5]`=callee, `frame[4]`=this, `frame[6]`=newTarget, args
   DESCEND from `frame[3]` (arg0=[3], arg1=[2], arg2=[1]; per
   `_sh_stackframe_get_arg_ptr(frame, n) = &ThisArg_ptr(frame)[-n-1]`), then
   `_sh_ljs_call(shr, frame, argc)`.
3. **`-exported-unit=NAME` works at pin `5cee10a`** — it applies
   `#define CREATE_THIS_UNIT sh_export_NAME` to the generated C and
   suppresses `main`. The plugin pipeline uses it
   (`sh_export_eded_plugin()` + lazy `_sh_init`/`_sh_initialize_units` from
   `plugin_init`). The process gotcha that cost time: `shermes -emit-c`
   writes the generated `<basename>.c` to the **current working directory**,
   not next to the input — bare manual invocations silently produce strays
   while stale files from earlier pipeline runs sit next to the input, and
   every check of "the" generated file reads the stale one. Pipeline scripts
   must `cd` to the target dir first (all of eded's do); re-verify the flag
   on hermes pin bumps.
4. **Microtask draining without the console event loop**: cordis fiber start
   and dispose completion are microtasks, and SH keeps its own queue (node's
   loop can't touch it). `hrt.drainMicrotasks()` drains it; the core shim
   drains after every entry point, so hosts observe effects synchronously on
   return (`run_event_loop` was rejected — it blocks waiting for tasks).
5. **cordis inject-miss + reactivity make the bridge honest**: a consumer
   registered before the service exists stays deferred; provide-from-plugin
   fires it; unload makes fresh injects defer again (p3b). No polling, no
   special cases — cordis's own semantics do the work.
6. Emscripten glue details that cost time: MODULARIZE glues (`-sMODULARIZE=1
   -sEXPORT_NAME=...`) are required for a usable host-side factory (the
   minified non-modularized glue exports nothing); emscripten 6 needs
   `-sEXPORTED_RUNTIME_METHODS=HEAPU8` for host→core memory writes; mixed
   C/C++ sources need separate `emcc -c` steps (`-std=c++17` poisons .c
   inputs); the modules import from a minified namespace (`"a"`) so they must
   always be instantiated through their glue, not bare
   `WebAssembly.instantiate` (which also demands an imports argument under
   node); hermes public headers need `-I API -I API/jsi -I public`.

### Decisions (2026-09-04)

- **WIT-shaped, hand-rolled v0; adoption deferred.** The v0 ABI is
  transcribable 1:1 onto a future `eded:plugin@0.1.0` WIT package (sync
  calls, integer params, s32 results). WIT/component-model adoption is
  re-pointed to ticket #3 (Wasmtime implements components natively) or
  whenever a second author/plugin ecosystem appears. Rejected for now: the
  browser has no native component support (transpiled-glue tax) and our
  shermes shim work remains regardless.
- **i32-only returns** (deviation from the sketched two-i32/multi-value
  return): hand-written C cannot emit multi-value returns, and BigInt under
  shermes is unproven. A WIT `call: func(...) -> s32` expresses the same
  shape; richer result types are ABI growth.
- **Separate memories, host-mediated routing.** Plugins never see each
  other's memory; the host is the only intermediary (proven by p5's
  independent instances). Shared memory rejected (nonstandard, breaks
  Wasmtime, defeats isolation).
- **Name via scratch-buffer copy**: the host writes the service-name bytes
  into core memory (`core_name_ptr` + HEAPU8 + `core_name_len_set`), proving
  the host→core copy pattern M5 will generalize. The core reads it back as a
  JSI string (`core_pending_name`).
- **Error channel is contract-level** (negative i32), not exception-level:
  emscripten links noexcept libc++, so C++ exceptions across the JSI boundary
  would abort. JS handlers must be total functions in v0; a real error
  channel is ABI growth (alongside an unload-completion callback, since
  `fiber.dispose()` completion is async while the export must return sync).

### Numbers (M4)

- core module (cordis + bridge + shim): **3.83 MB** (-O3, unstripped; M3's
  cordis-only suite was 4.0 MB — the probe suite outweighed the bridge).
- shermes-JS plugin: **3.16 MB** with `--no-entry` (3.2 MB via the M3-style
  glue) — the per-plugin runtime floor stands; plugin code adds ~nothing.
- C toy plugin: **241 bytes**. The 3.16 MB vs 241 B contrast is the M6 size
  lever: every shermes-JS plugin carries a full VM, so size engineering
  (-Os/strip/brotli, and dropping the core's idle interpreter) is confirmed
  as M6 work.
- Probe suite: 12/12 under the node host rung (p0 init; p1 JS round-trip
  add(20,22)=42; p2 C toy mul(6,7)=42; p3 unload→dispose routed; p3b inject
  defers after unload; p4 full round trip synchronous in one host call; p5
  two instances of one module with isolated state).

### Verification

- `spike/plugin-bridge/run-m4.sh`: rebuilds C toy, JS plugin, core; runs the
  host harness under node; **GREEN 12/12** (2026-09-04).
- `core/core-oracle.mjs`: GREEN 8/8 under plain node (cordis semantics pin).
- **Browser rung: GREEN, visually confirmed 2026-09-04** (served locally,
  opened in Chromium; verdict GREEN on page and console, `onunhandledrejection`
  hooked per M2). All three rungs of the spike are green.

### Carried to M5

- The **UI-declaration contract** remains the key open design question (per
  plan.md): how plugins get UI on screen — per-frame immediate clay calls
  across the ABI, batched element-fragment buffers, or a panels service.
  The v0 call-routing proven here is the substrate whichever wins.
- ABI growth queue (in demand order, per "grows on demand"): string/bytes
  parameters (generalize the scratch buffer), an unload-completion callback,
  a real error channel, plugin-side inject (deps declared across the bridge).
- Numbers to re-take at M6: instantiate cost per JS plugin module (memory as
  well as bytes — each carries its own heap), and stripped/-Os sizes.
