// M5 host harness (node rung). Extends the M4 host: it instantiates the core
// and plugin modules, routes the bridge (pluginCall/pluginDispose), supplies
// the text-measure import (monospace terminal metrics back through the f32
// scratch), and routes plugin UI fragments (vocab) back into the core.
//
// Modes:
//   node host.mjs        — probe suite (PASS|FAIL contract, VERDICT, exit code)
//   node host.mjs --tui  — interactive terminal demo (renderer + raw-mode input)
//
// Output contract (M2/M3): PASS|FAIL lines, RESULT, VERDICT, exit = failures.

import { createRequire } from "node:module";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  Screen, parseCommands, buildOffsets, enterTui, leaveTui,
  decodeInput, CELL_W, CELL_H,
} from "./ui-renderer.mjs";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const TUI = process.argv.includes("--tui");

// --- host state -------------------------------------------------------------
const plugins = new Map(); // handle -> { call, dispose, label, m }
let nextHandle = 1;
let bridgeCore = null; // core module (measure/vocab need its heap views)
let activeModule = null; // plugin instance currently executing (vocab byte reads)
const bridgeTrace = []; // every host-mediated call, in order

globalThis.__ededHost = {
  // clay's measure import: host-supplied text measure. Reads ASCII bytes from
  // core memory and writes a f32 {width, per-line-height} pair into the
  // scratch pointer C passed in (M4 scratch-copy pattern, generalized).
  measureText(ptr, len, maxW, outPtr) {
    void maxW;
    const dv = new DataView(bridgeCore.HEAPU8.buffer);
    dv.setFloat32(outPtr, len * CELL_W, true); // monospace: CELL_W per ASCII byte
    dv.setFloat32(outPtr + 4, CELL_H, true); // one terminal row per line
  },
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
  // plugin -> core vocabulary route (the M5 UI-declaration probe)
  vocab(fn, a, b) {
    if (fn === 3 /* FG_TEXT */) {
      const m = activeModule && activeModule.HEAPU8;
      if (!m) return -98;
      const dst = bridgeCore._clay_allbuf_ptr();
      bridgeCore.HEAPU8.set(m.subarray(a, a + b), dst);
      return bridgeCore._vui_dispatch(3, 0, b);
    }
    return bridgeCore._vui_dispatch(fn, a, b);
  },
};

globalThis.__ededClay = {
  error(errType, chars, len) {
    const bytes = bridgeCore.HEAPU8.subarray(chars, chars + len);
    console.error("[clay error]", errType, String.fromCharCode(...bytes));
  },
};

// --- module loading (host-mediated instantiation) -----------------------------
async function instantiateCore() {
  const create = require(path.join(here, "core/core-wasm.js"));
  const t0 = performance.now();
  const core = await create();
  bridgeCore = core; // measure/vocab callbacks can fire as soon as init runs
  return { core, ms: performance.now() - t0 };
}

async function loadUiPlugin(label) {
  const createPluginModule = require(path.join(here, "plugin-ui-wasm.js"));
  const t0 = performance.now();
  const m = await createPluginModule();
  const ms = (performance.now() - t0).toFixed(1);
  const handle = nextHandle++;
  plugins.set(handle, {
    label,
    m, // its HEAPU8 serves the vocab text byte reads
    call: (fn, a, b) => {
      const was = activeModule;
      activeModule = m;
      try {
        return m._plugin_call(fn, a, b);
      } finally {
        activeModule = was;
      }
    },
    dispose: () => m._plugin_dispose(),
  });
  m._plugin_init();
  return { handle, ms };
}

function coreLoad(core, handle, name) {
  const bytes = new TextEncoder().encode(name);
  const ptr = core._core_name_ptr();
  core.HEAPU8.set(bytes, ptr);
  core._core_name_len_set(bytes.length);
  return core._core_load_plugin(handle);
}

function coreIdOf(core, str) {
  const bytes = new TextEncoder().encode(str);
  const ptr = core._clay_allbuf_ptr();
  core.HEAPU8.set(bytes, ptr);
  return core._clay_id_of(ptr, bytes.length);
}

// --- probe reporting -----------------------------------------------------------
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
const near = (got, want, eps = 1) =>
  Array.isArray(got) && Array.isArray(want) &&
  got.length === want.length &&
  got.every((v, i) => Math.abs(v - want[i]) <= eps);

// === run ========================================================================
const t0c = performance.now();
const inst = await instantiateCore();
const coldStartMs = performance.now() - t0c;
const core = inst.core;
const off = buildOffsets(core);

// === TUI mode ==============================================================tui guard
if (TUI) {
  await runTui(core, off, process.stdout);
  process.exit(0);
}

// === probe mode =================================================================
check("p0-core-init", core._core_init() === 0, "core_init failed");

check("p1-frame-produces-commands",
  core._core_dimensions(640, 384) === 0 && core._core_frame(16.6) === 0 && core._core_render_len() > 0,
  "frame rc=" + core._core_frame(16.6) + " len=" + core._core_render_len());
check("p2-measure-import-fired", core._clay_measure_calls() > 0, `calls=${core._clay_measure_calls()}`);
check("p1b-no-clay-errors", core._clay_errors() === 0, `errors=${core._clay_errors()}`);

// wire parse: commands come out sane and a title text is present
function cmdsOf(core) {
  return parseCommands(core, core._core_render_ptr(), core._core_render_len(), off);
}
{
  const cmds = cmdsOf(core);
  const typesOk = cmds.every((c) => c.type >= 0 && c.type <= 7);
  const hasTitle = cmds.some((c) => c.type === 3 && /eded\|m5 - clay/.test(c.text));
  const boxesOk = cmds.every((c) => !Number.isNaN(c.x) && !Number.isNaN(c.y));
  check("p3-wire-parse", typesOk && hasTitle && boxesOk, JSON.stringify({ typesOk, hasTitle, boxesOk, n: cmds.length }));
  const textIds = new Set(cmds.filter((c) => c.id !== 0).map((c) => c.id));
  check("p3b-cmd-ids-present", cmds.some((c) => c.id !== 0), "no ids in command stream");
  void textIds;
}

// locate the button via its declared id, hover it, verify paint changes
const btnId = coreIdOf(core, "demo-btn");
function findBtnCmd(core) {
  const cmds = cmdsOf(core);
  for (const c of cmds) if (c.type === 1 && c.id === (btnId >>> 0)) return c;
  return null;
}
{
  const btn = findBtnCmd(core);
  check("p4-btn-located", !!btn, `btnId=0x${(btnId >>> 0).toString(16)}`);
  core._core_pointer(btn.x + btn.w / 2, btn.y + btn.h / 2, 0);
  core._core_frame(16.6);
  const hovered = findBtnCmd(core);
  const want = [0x36, 0x51, 0x64, 0xff];
  check("p4-hover-paint", hovered && near(hovered.bg, want), JSON.stringify(hovered && hovered.bg));
}

// click: down edge (pointer already over) -> frame -> plugin add(20,22)=42 via bridge
{
  const btn = findBtnCmd(core);
  if (!btn) {
    check("p5-click-bridge-service", false, "button not located");
    check("p5-sync-frame", false, "no button to sync-test");
  } else {
    core._core_pointer(btn.x + btn.w / 2, btn.y + btn.h / 2, 1);
    const before = bridgeTrace.length;
    core._core_frame(16.6); // single synchronous call reaches the plugin
    const synced = bridgeTrace.length > before;
    core._core_pointer(btn.x + btn.w / 2, btn.y + btn.h / 2, 0);
    const cmds = cmdsOf(core);
    const sum = cmds.some((c) => c.type === 3 && /added 42 over the bridge/.test(c.text));
    check("p5-click-bridge-service", sum && synced,
      JSON.stringify(cmds.filter((c) => c.type === 3).map((c) => c.text)));
    check("p5-sync-frame", synced, "no plugin hit during synchronous frame call");
  }
}

// bridged plugin UI fragment: per-frame vocabulary over the bridge
{
  const cmds = cmdsOf(core);
  const frag = cmds.some((c) => c.type === 3 && /ui: plugin fragment/.test(c.text));
  check("p6-plugin-fragment", frag, "fragment text not found in commands");
}

// === numbers ====================================================================
const coreSize = statSync(path.join(here, "core/core-wasm.wasm")).size;
const jsPluginSize = statSync(path.join(here, "plugin-ui-wasm.wasm")).size;
console.log(`NUMBERS core=${(coreSize / 1048576).toFixed(2)}MB js-plugin=${(jsPluginSize / 1048576).toFixed(2)}MB cold-start=${coldStartMs.toFixed(1)}ms`);

console.log("RESULT: " + (total - fails) + "/" + total + " probes passed");
console.log("VERDICT: " + (fails ? "RED (" + fails + ")" : "GREEN"));
process.exitCode = fails;

// === TUI runner ==============================================================
async function runTui(core, off, out) {
  core._core_init();
  const { handle } = await loadUiPlugin("uicounter");
  coreLoad(core, handle, "uicounter");

  const cols = out.columns | 0, rows = out.rows | 0;
  enterTui(out);
  let first = true;
  const screen = new Screen(out);
  const fit = () => {
    const c = out.columns | 0 || 80, r = out.rows | 0 || 24;
    screen.resize(c, r);
    core._core_dimensions(c * CELL_W, r * CELL_H);
    if (first) first = false;
    frame();
  };
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.on("data", (chunk) => {
    for (const ev of decodeInput(chunk)) {
      if (ev.type === "key") {
        if (ev.key === "quit" || ev.key === "esc") stop();
      } else {
        core._core_pointer(ev.x * CELL_W, ev.y * CELL_H, ev.type === "down" ? 1 : 0);
      }
    }
  });
  out.on("resize", fit);
  fit();
  const timer = setInterval(frame, 16.6);
  let stopping = false;
  function frame() {
    if (stopping) return;
    core._core_frame(16.6);
    screen.paint(parseCommands(core, core._core_render_ptr(), core._core_render_len(), off));
    screen.flush();
  }
  function stop() {
    clearInterval(timer);
    stdin.setRawMode(false);
    leaveTui(out);
    console.log("m5 tui: bye");
  }
}
