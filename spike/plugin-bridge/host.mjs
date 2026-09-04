// M4 host harness (node rung). The host is the wasm mediator the architecture
// requires: it instantiates the core and each plugin module, keeps the
// handle -> instance bridge table, and routes host_plugin_call/dispose between
// core and plugins. Browser twin: index.html (same logic, see FINDINGS).
//
// Output contract (M2/M3): PASS|FAIL lines, RESULT, VERDICT, exit = failures.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

// --- host state -------------------------------------------------------------
const plugins = new Map(); // handle -> { call, dispose, label }
let nextHandle = 1;
const bridgeTrace = []; // every host-mediated call, in order

globalThis.__ededHost = {
  pluginCall(handle, fn, a, b) {
    const p = plugins.get(handle);
    bridgeTrace.push(`call:${p ? p.label : handle}:${fn}`);
    if (!p) return -97;
    return p.call(fn, a, b);
  },
  pluginDispose(handle) {
    const p = plugins.get(handle);
    bridgeTrace.push(`dispose:${p ? p.label : handle}`);
    if (!p) return -97;
    const r = p.dispose();
    plugins.delete(handle);
    return r;
  },
};

// --- module loading (host-mediated instantiation) ---------------------------
async function loadCore() {
  const createCore = require(path.join(here, "core/core-wasm.js"));
  const t0 = performance.now();
  const core = await createCore();
  const ms = (performance.now() - t0).toFixed(1);
  return { core, ms };
}

async function loadJsPluginModule(label) {
  const createPluginModule = require(path.join(here, "plugin-counter-wasm.js"));
  const t0 = performance.now();
  const m = await createPluginModule();
  const ms = (performance.now() - t0).toFixed(1);
  const handle = nextHandle++;
  plugins.set(handle, {
    label,
    call: (fn, a, b) => m._plugin_call(fn, a, b),
    dispose: () => m._plugin_dispose(),
  });
  m._plugin_init();
  return { handle, ms };
}

async function loadCPluginModule(label) {
  const bytes = readFileSync(path.join(here, "toy.wasm"));
  const t0 = performance.now();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ms = (performance.now() - t0).toFixed(1);
  const handle = nextHandle++;
  plugins.set(handle, {
    label,
    call: (fn, a, b) => instance.exports.plugin_call(fn, a, b),
    dispose: () => instance.exports.plugin_dispose(),
  });
  instance.exports.plugin_init();
  return { handle, ms };
}

// --- core surface helpers ---------------------------------------------------
function coreLoad(core, handle, name) {
  const bytes = new TextEncoder().encode(name);
  const ptr = core._core_name_ptr();
  core.HEAPU8.set(bytes, ptr); // host -> core memory copy (scratch buffer)
  core._core_name_len_set(bytes.length);
  return core._core_load_plugin(handle);
}

function coreCall(core, fn, a, b) {
  // name is irrelevant to the probe consumer (it used the loaded name), but
  // keep the buffer pointing at the last loaded name for clarity
  return core._core_call_service(fn, a, b);
}

// --- probe reporting --------------------------------------------------------
let fails = 0;
let total = 0;
function check(name, ok, detail) {
  total++;
  if (ok) console.log("PASS " + name);
  else {
    fails++;
    console.log("FAIL " + name + " - " + detail);
  }
}

// === probes ==================================================================
const { core, ms: coreMs } = await loadCore();
check("p0-core-init", core._core_init() === 0, "core_init failed");

// p1: shermes-JS plugin — provide/inject/call round-trip through the bridge
{
  const { handle } = await loadJsPluginModule("js-counter");
  const rc = coreLoad(core, handle, "counter");
  const v = coreCall(core, 0, 20, 22); // add(20,22) via cordis -> bridge -> plugin
  check("p1-load", rc === 0, "load rc=" + rc);
  check("p1-roundtrip", v === 42, "add(20,22) through bridge = " + v);
}

// p2: C toy plugin — same ABI, different toolchain
{
  const { handle } = await loadCPluginModule("c-toy");
  const rc = coreLoad(core, handle, "toy");
  const v = coreCall(core, 1, 6, 7); // mul(6,7)
  check("p2-load", rc === 0, "load rc=" + rc);
  check("p2-roundtrip", v === 42, "mul(6,7) through bridge = " + v);
}

// p3: dispose ordering — unload routes teardown to the plugin
{
  const before = bridgeTrace.length;
  const { handle } = await loadCPluginModule("c-toy-2");
  coreLoad(core, handle, "shortlived");
  const v = coreCall(core, 0, 1, 2); // add(1,2)=3
  const rc = core._core_unload_plugin(handle);
  const disposed = bridgeTrace.slice(before).some((t) => t.startsWith("dispose:c-toy-2"));
  check("p3-call-before-unload", v === 3, "v=" + v);
  check("p3-unload-rc", rc === 0, "rc=" + rc);
  check("p3-dispose-routed", disposed, "no dispose in bridge trace");
}

// p3b: service gone after unload — a fresh consumer of the same name misses
{
  const { handle } = await loadCPluginModule("c-toy-3");
  coreLoad(core, handle, "ephemeral");
  check("p3b-present", coreCall(core, 0, 5, 5) === 10, "expected 10");
  core._core_unload_plugin(handle);
  const sentinel = coreCall(core, 0, 5, 5); // consumer registered, never fires
  check("p3b-miss-after-unload", sentinel === -96, "got " + sentinel);
}

// p4: sync guarantee — the full round trip is one synchronous host call
{
  const { handle } = await loadJsPluginModule("js-counter-2");
  coreLoad(core, handle, "counter2");
  const callsBefore = bridgeTrace.length;
  const v = core._core_call_service(0, 20, 22); // no await anywhere
  const syncCall = bridgeTrace.length === callsBefore + 1; // plugin hit during the call
  check("p4-sync-roundtrip", v === 42 && syncCall,
    "v=" + v + " traceDelta=" + (bridgeTrace.length - callsBefore));
}

// p5: double-instantiate — same module twice, isolated state
{
  const a = await loadJsPluginModule("js-inst-a");
  const b = await loadJsPluginModule("js-inst-b");
  coreLoad(core, a.handle, "inst-a");
  coreLoad(core, b.handle, "inst-b");
  core._core_name_len_set(new TextEncoder().encode("inst-a").length);
  core._core_name_ptr(); // (name already set by coreLoad)
  const nameSet = (n) => {
    const bytes = new TextEncoder().encode(n);
    core.HEAPU8.set(bytes, core._core_name_ptr());
    core._core_name_len_set(bytes.length);
  };
  nameSet("inst-a");
  const va1 = core._core_call_service(3, 99, 0); // set(99) -> old 0
  const va2 = core._core_call_service(2, 0, 0); // get -> 99
  nameSet("inst-b");
  const vb1 = core._core_call_service(2, 0, 0); // get -> 0 (independent!)
  check("p5-isolated-state", va1 === 0 && va2 === 99 && vb1 === 0,
    `a.set=${va1} a.get=${va2} b.get=${vb1}`);
}

// === numbers =================================================================
const jsSize = (await import("node:fs")).statSync(path.join(here, "plugin-counter-wasm.wasm")).size;
const cSize = (await import("node:fs")).statSync(path.join(here, "toy.wasm")).size;
const coreSize = (await import("node:fs")).statSync(path.join(here, "core/core-wasm.wasm")).size;
console.log(`NUMBERS core=${(coreSize / 1048576).toFixed(2)}MB js-plugin=${(jsSize / 1048576).toFixed(2)}MB c-plugin=${cSize}B`);

console.log("RESULT: " + (total - fails) + "/" + total + " probes passed");
console.log("VERDICT: " + (fails ? "RED (" + fails + ")" : "GREEN"));
process.exitCode = fails;
