# eded — plan

Single source of truth for the architecture and the work ladder; a fresh
session should be able to start any ticket from this document alone.

## What eded is

A modular editor. cordis (`@deepseek-ai/cordis`, pure ESM) owns the plugin
lifecycle — DI, startup wiring, teardown. clay (`nicbarker/clay`, single-header
C) owns layout. The core is ONE wasm module with **no embedded JS engine**:
cordis and the core's own JS are compiled ahead of time to wasm via
**Static Hermes** (facebook/hermes, `static_h` branch — compiles full ES6 to
wasm). The interpreter is linked in the current pipeline but nothing evals;
dropping it for a lean core is an M6 size lever.

**Plugin model (decided 2026-09-04): a plugin is a wasm module, nothing
else.** The host instantiates plugin modules and bridges them to the core
through a narrow ABI; cordis stays in the core and plugins are its clients.
There is no eval path and no privileged plugin language. JS is a first-class
*producer* (JS -> shermes -> wasm — the exact M3 pipeline), so any tool that
emits JS (wisp2 included) works as an external authoring option without
being part of the architecture. eded is a solo project for the foreseeable
future, so the plugin ABI starts minimal and grows on demand.

## Architecture

```
+-------------------------------------------------------------------+
|                           host runtime                            |
|  web: emscripten-free browser host   desktop: Wasmtime C API      |
|  renderer plugin: canvas2d           renderer plugin: sokol       |
|  (later: termbox TUI renderer)       plugin loader: Wasmtime      |
+---------------------+-----------------------------+---------------+
                      |  host ABI (narrow, platform-neutral):
                      |  init / frame(dt) / input / measure-text /
                      |  render-commands / load-plugin
+---------------------v---------------------------------------------+
|                    EDED CORE — one wasm module                    |
|  clay (layout, C) wrapped as the `layout` cordis service           |
|  C ABI dispatcher                                                  |
|  AOT-compiled cordis (no JS engine inside)                        |
|  plugins: separate wasm modules, host-instantiated + bridged      |
|    (any producer: C, Rust, JS via shermes, ...)                   |
|  Clay_RenderCommandArray -> whichever renderer is attached        |
+-------------------------------------------------------------------+
```

Design invariants:

1. **Renderers own no layout.** They consume render commands and push input.
   The core never sees a window, GPU or canvas.
1b. **Layout is an in-core cordis service, not a remote module.** clay is
   wrapped as the injectable `layout` service so the "everything is a
   plugin" philosophy holds where it matters (lifecycle, injection,
   replacement) without putting the frame path behind module hops. The
   harness's tui/webui lesson is about presentation — honored by renderer
   plugins — not about layout, which is the shared substrate every plugin's
   UI must compose into. Revisit trigger: if a second layout engine becomes
   real or plugin UI outgrows clay's model, the element vocabulary moves
   into the ABI and clay can move out freely; until then, abstracting it
   is speculative generality for exactly one layout engine.
1a. **The core module is single-threaded.** Finalizers that upstream defers
   to a worker thread run inline instead (see
   `patches/hermes-serial-executor-singlethread.patch`). Emscripten pthreads
   would lock the browser host behind COOP/COEP and Wasmtime behind
   wasi-threads; the sync-frame invariant wants neither. Revisit only if M2+
   proves it necessary.
2. **Plugin loading is host-mediated.** No engine in the pipeline can
   instantiate nested wasm modules (quickjs-ng ships no WebAssembly builtin;
   an AOT-compiled core is not a wasm host). The host instantiates plugin
   modules and bridges them to the core. This is what makes "any language
   that compiles to wasm is a plugin language" true.
3. **The per-frame loop stays synchronous.** No `await` in the frame path
   (carried from the wisp2 spike findings). cordis handles async lifecycle
   wiring; frames are sync layout + paint.
4. **The host ABI is narrow and platform-neutral.** One header
   (`eded_core.h`), implemented by every host. The same core module must run
   under a browser host and a native wasm-runtime host.
5. **A plugin is a wasm module.** No eval path, no privileged plugin
   language; plugins reach the core only through the ABI, with the cordis
   lifecycle managed in-core (each bridged plugin is wrapped as an arrow
   function — see the isConstructor gotcha). Known cost: every shermes-JS
   module carries its own runtime (~3.2 MB before plugin code); measure at
   M4 before deciding whether size engineering (-Os, strip, brotli, lazy
   instantiate) lands in M6 scope.

## Why Static Hermes AOT (and the fallback ladder)

The engine question was evaluated against four shapes: quickjs-ng embedded in
the module, Static Hermes AOT, host-provided JS realm, and small ES5 engines
(mquickjs/MuJS — non-starters: cordis needs Proxy/WeakRef/async).

Static Hermes AOT won on the goal: plugins become true wasm modules —
the purest form of the "wasm core complements cordis modularity" vision — and
the core carries no interpreter for compiled code.

Honest risks: shermes native compilation is **officially experimental**;
Proxy-trap semantics under AOT are the specific unproven thing cordis leans
on; the two-stage build churns; shermes emits emscripten-flavored wasm
(running under Wasmtime may need `STANDALONE_WASM` / WASI shims).

Fallback ladder if the kill-test fails (each rung pre-scoped):

```
B  shermes AOT (current)
B' embed the Hermes VM wasm (engine-in-module, Hermes flavor)
C  host provides the JS realm (browser JS on web; native quickjs via the
   wisc lineage on desktop; core = clay only)
A  quickjs-ng embedded in the module (what wisp2 #3 originally asked)
```

A red kill-test costs a comment and a ticket re-point, not a replan.

## Work ladder

Tracked on ~takeiteasy/eded:

| # | Ticket | Substance |
|---|--------|-----------|
| 1 | Spike: Static Hermes AOT — engine-less core module | Milestone ladder M1–M6 below; produces the first core module + FINDINGS.md |
| 2 | Bootstrap: repo skeleton, host ABI v0, renderer plugin contract | Repo becomes real; canvas2d renderer plugin #1; demo plugin (JS-via-shermes or C) |
| 3 | Desktop host: Wasmtime + sokol renderer plugin | Native rung; sokol_app + sokol_gfx; clay ships an official sokol renderer to crib from |
| 4 | Spike: any-language wasm plugin bridge (host-mediated) | Foreign wasm module (C/Rust toy) bridged into cordis as an ordinary plugin |

Order: #1 first (cheapest disproof); #2 unblocks #3 and #4, which can run in
parallel.

### Spike milestones (ticket #1)

Iterate natively first — the shermes native target is the fast dev loop;
flip to the wasm target per milestone.

- **M1 Toolchain**: build static_h (host hermesc, two-stage) + wasm target via
  the documented emscripten path; run `utils/wasm-compile.sh` hello under node
  and a browser. **Done 2026-09-04** (static_h pinned `5cee10a`; see
  FINDINGS.md — two host-side fixes landed: single-threaded SerialExecutor
  patch, WebCrypto resizable-view override).
- **M2 KILL-TEST**: cordis's load-bearing ES features under AOT — Proxy traps
  (cordis's Context/DI is Proxy-based), WeakRef, async/await, class static
  blocks, private fields. If red, stop, invoke the fallback ladder.
  **Done 2026-09-04: GREEN** (11/11 probes on native + wasm + browser; one
  compile-level caveat — shermes rejects `async function*`, and the cordis
  bundle contains one; mitigated in M3 by esbuild `--target=es2017`
  lowering. See FINDINGS.md).
- **M3 cordis AOT end to end**: esbuild IIFE (`--target=es2017` to lower
  async generators; see M2 findings) -> hermesc -> C/link -> wasm;
  lifecycle test (provide / inject / effect / dispose) under a wasm runtime.
  **Done 2026-09-04: GREEN** (native + wasm under node + browser, visually
  confirmed). Key discovery: static_h defaults to legacy ES5 scoping —
  **`-Xes6-block-scoping` is mandatory** or loop-captured `let`/`const`
  closures share one binding (baked into `compile.sh`; see FINDINGS.md).
- **M4 plugin bridge (model decided — B2)**: prove one real plugin module
  (shermes-JS and/or C toy) as its own wasm module, host-instantiated and
  bridged into cordis through a v0 ABI (minimal, grows on demand — solo
  project). Measure the per-plugin module size first: each shermes-JS
  module carries its own runtime (~3.2 MB pre-plugin-code at M3 flags);
  that number drives whether size engineering (-Os, strip, brotli, lazy
  instantiate) becomes M6 work.
- **M5 clay + ABI**: clay.c linked in-core and wrapped as the `layout`
  cordis service; browser canvas2d host paints the RenderCommandArray via
  rAF; host-supplied text measure (canvas `measureText`); input events flow
  in. Carries the key open design question of the UI era: the
  **UI-declaration contract** — how plugins get UI on screen (per-frame
  immediate clay calls across the ABI, batched element-fragment buffers, or
  a high-level panels service à la Koishi's console). Shapes the plugin ABI
  far more than clay's address; freeze only when a real plugin needs UI.
- **M6 numbers**: module size, cold start, per-frame cost; FINDINGS.md.

## Toolchain prereqs

- emcc (6.0.2 present), cmake, node — already on this machine.
- static_h: clone facebook/hermes at the `static_h` branch, pin it (likely
  `vendor/hermes` submodule); two-stage build per its `doc/Emscripten.md`
  (`HERMES_UNICODE_LITE=ON` is only needed for "pure" wasm hosts without the
  emscripten glue — revisit at the Wasmtime rung;
  `-sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=256KB` are the documented flags; the
  cross-build flag is `IMPORT_HOST_COMPILERS`).
- clay: vendor (submodule or pinned header — decided in ticket #2).
- cordis: `@deepseek-ai/cordis` — pure ESM, only imports cosmokit; bundle
  with esbuild `--format=iife --target=es2017` (~79 kB with lowering
  machinery; es2017 lowers async generators, see M2/M3 findings). The same
  pipeline compiles any JS into a plugin module.

## Gotchas carried from prior evidence

- **static_h needs `-Xes6-block-scoping`**: legacy ES5 scoping is the
  default; loop-captured `let`/`const` closures silently share one binding
  (final value wins) without it — interpreter, native and wasm alike. Baked
  into `spike/shermes-aot/compile.sh`; re-verify with
  `spike/cordis-aot/probe-loop-scoping.js` after any hermes pin bump.

- **isConstructor**: cordis classifies any function with a `.prototype` as a
  class and runs `new plugin()`, dropping a *returned* disposer. Use
  `ctx.effect()` for teardown (or arrow plugins). The core wraps each
  bridged plugin as an arrow function, so plugin modules never hit this.
- **Job queue**: embedded-engine hosts must drain `JS_ExecutePendingJob`
  (proven in the wisp2 quickjs spike). Irrelevant for AOT code, but
  applies to every fallback rung that embeds an engine, and to the browser
  host's microtask handling around cordis awaits.
- **Clay text measure**: clay requires a host-supplied measure function; on
  web, back it with canvas `measureText` via an EM_JS trampoline (web rung)
  or a native font stack (desktop rung, ticket #3).
- **Clay renderers exist upstream**: canvas2d, HTML, sokol, raylib, SDL2/3 —
  crib, don't hand-roll.
- **emcc↔Wasmtime friction**: shermes's wasm output targets emscripten;
  ticket #3 must answer whether `STANDALONE_WASM` / a WASI rebuild is needed.

## Kickoff (fresh session, ticket #1)

1. Read ticket #1 on the tracker (~takeiteasy/eded).
2. Verify prereqs: `emcc --version`, `cmake --version`, `node --version`;
   clone facebook/hermes at `static_h`, pin a commit.
3. M1 first — nothing else matters until a hello-world compiles JS -> wasm
   and runs under node and a browser.
4. M2 is the kill-test: Proxy-heavy toy first (a mini cordis-shaped Context),
   then real cordis. Do not build M3+ UI work before M2 is green.
5. Record everything in FINDINGS.md as you go; update this doc when a
   decision lands (plugin model, ABI shape, fallback re-points).
