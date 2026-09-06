// M5 core entry: cordis owns lifecycle; clay (C) is wrapped as the injectable
// `layout` cordis service (plan invariant 1b) — service methods map onto the
// immediate-mode clay vocabulary attached by core-shim.cpp. The spike demo UI
// is built per-frame through that SAME service, and registered bridge plugins
// contribute per-frame UI fragments across the ABI (host-routed vui calls).
//
// Imports (JSI host functions attached by core-shim.cpp):
//   host_plugin_call / host_plugin_dispose / core_pending_name (M4)
//   clay_buf / clay_set_id / clay_layout / clay_bg / clay_border / clay_clip /
//   clay_open / clay_close / clay_text / clay_over (M5 vocabulary)

import { Context } from "@deepseek-ai/cordis";

var ctx = null;
var fibers = {}; // handle -> fiber
var uiPlugins = []; // handles pulled for UI fragments during frame
var svc = null; // cached `layout` service (injected at init — no injects in the frame path)
var app;

// sizing tuples: [raw Clay__SizingType, value]
//   FIT=0 (value unused), GROW=1 (value = max clamp, 0 = unbounded),
//   PERCENT=2 (0..1 of parent), FIXED=3 (exact px)
var FX = (v) => [3, v];
var GR = (v) => [1, v];
var FIT = [0, 0];
var PC = (v) => [2, v];

var DIR_ROW = 0; // Clay_LayoutDirection: LEFT_TO_RIGHT = 0
var DIR_COL = 1; //                TOP_TO_BOTTOM = 1
var AX_CENTER = 2; // Clay_LayoutAlignmentX: LEFT 0, RIGHT 1, CENTER 2

function makeLayout() {
  return {
    fx: FX, gr: GR, fit: FIT, pc: PC, row: DIR_ROW, col: DIR_COL,
    box(o) {
      clay_reset();
      if (o.id !== undefined) {
        var n = clay_buf(o.id);
        clay_set_id(n);
      }
      var w = o.w || FIT, h = o.h || FIT;
      var pad = o.pad || [0, 0, 0, 0];
      clay_layout(
        w[0], w[1], h[0], h[1],
        pad[0] | 0, pad[1] | 0, pad[2] | 0, pad[3] | 0,
        o.gap | 0,
        (o.align && o.align[0]) | 0, (o.align && o.align[1]) | 0,
        o.dir | 0
      );
      if (o.bg !== undefined) clay_bg(o.bg);
      if (o.border !== undefined) clay_border(o.border, o.borderFg !== undefined ? o.borderFg : 0x9ca3afff);
      if (o.clip) clay_clip(o.clip[0], o.clip[1]);
      return clay_open();
    },
    text(str, o) {
      o = o || {};
      var n = clay_buf(str);
      return clay_text(n, o.size | 0, o.fg === undefined ? 0xd4d4d8ff : o.fg, o.wrap ? 1 : 0);
    },
    close() {
      clay_close();
    },
    over(id) {
      return clay_over(id) === 1;
    },
  };
}

globalThis.eded_core_init = function () {
  ctx = new Context();
  fibers = {};
  uiPlugins = [];
  svc = null;
  app = {
    frame: 0,
    sum: null, // result of the bridge click round-trip
    down: false,
    prevDown: false,
    pressed: false, // pressed edge, consumed by the button handler
    px: -1,
    py: -1,
    uiHandle: 0,
  };
  ctx.plugin((local) => local.provide("layout", makeLayout()));
  // consume through the inject machinery (not a direct reference) so the
  // service is exercised the way in-core consumers will use it
  ctx.plugin((local) => {
    local.inject(["layout"], (c) => {
      svc = c.layout;
    });
  });
  return 0;
};

globalThis.eded_core_load_plugin = function (handle) {
  if (!ctx) return -14;
  if (fibers[handle]) return -15;
  var name = core_pending_name();
  var fiber = ctx.plugin((local) => {
    local.effect(() => () => {
      host_plugin_dispose(handle);
    });
    local.provide(name, {
      call: (fn, a, b) => host_plugin_call(handle, fn, a, b),
    });
  });
  fibers[handle] = fiber;
  uiPlugins.push(handle); // every plugin is invited to draw a UI fragment (fn 1)
  svc = svc || null; // untouched
  app.uiHandle = handle; // spike demo: the newest plugin doubles as the click target
  return 0;
};

globalThis.eded_core_unload_plugin = function (handle) {
  var fiber = fibers[handle];
  if (!fiber) return -1;
  delete fibers[handle];
  var i = uiPlugins.indexOf(handle);
  if (i >= 0) uiPlugins.splice(i, 1);
  if (app.uiHandle === handle) app.uiHandle = 0;
  fiber.dispose();
  return 0;
};

// pointer bookkeeping from the host (position + down-edge for click detection)
globalThis.eded_pointer = function (x, y, down) {
  app.px = x;
  app.py = y;
  if (down && !app.prevDown) app.pressed = true;
  app.prevDown = down;
};

// M4 probe surface (unchanged semantics)
var lastResult = -96;
globalThis.eded_core_call_service = function (fn, a, b) {
  var name = core_pending_name();
  lastResult = -96;
  var fiber = ctx.plugin((local) => {
    local.inject([name], (c) => {
      lastResult = c[name].call(fn, a, b);
    });
  });
  fibers["__probe" + fn] = fiber;
  return 0;
};
globalThis.eded_core_call_service_result = function () {
  return lastResult;
};

// --- the frame: immediate-mode UI build, then clay (C) lays out --------------
// Sync path: no awaits, no fiber starts; plugin fragments ride the proven
// host_plugin_call hop, the plugin answering with vui(...) calls.

function str(v) {
  if (app.sum === null) return "click -> uicounter.add(20,22) over the bridge";
  return "added " + app.sum + " over the bridge";
}

globalThis.eded_ui_frame = function (micros) {
  try {
    return eded_ui_frame_inner(micros);
  } catch (e) {
    host_log("eded_ui_frame threw: " + (e && e.message ? e.message : typeof e));
    if (e && e.stack) host_log(String(e.stack).split("\n").slice(0, 4).join(" | "));
    return -4;
  }
};

function eded_ui_frame_inner(micros) {
  if (!svc) return -3;
  app.frame++;
  var hover = svc.over("demo-btn"); // one-frame-latency hover query

  svc.box({
    w: GR(0), h: FX(384), dir: DIR_COL, pad: [6, 6, 6, 6], gap: 4,
    bg: 0x131316ff,
  });
  svc.text("eded", { size: 20 });
  svc.text(str(), { size: 14, fg: 0x7dd3fcff });
  svc.box({ w: GR(0), h: FX(26), gap: 4, dir: DIR_ROW });
  svc.text("stat", { size: 12 });
  svc.close();
  svc.box({ w: FX(300), h: FX(110), bg: 0x0a0a0cff, border: 1, align: [AX_CENTER, 0], pad: [4, 4, 4, 4], gap: 4 });
  svc.text("sizes", { size: 12 });
  svc.close();
  svc.box({ w: FX(280), h: FX(64), bg: 0x0b0b12ff, pad: [2, 2, 2, 2] });
  svc.box({ w: FX(500), h: FX(24), bg: 0x4c1d95ff });
  svc.text("overflowing", { size: 12 });
  svc.close();
  svc.close();
  svc.box({
    id: "demo-btn", w: FX(200), h: FX(34), dir: DIR_ROW,
    align: [2, 0], pad: [4, 4, 4, 4], gap: 6,
    bg: hover ? 0x365164ff : 0x1f2937ff,
    border: 2, borderFg: 0x22c55eff,
  });
  svc.text("click me ->", { size: 14, fg: 0x86efacff });
  if (hover && app.pressed) {
    app.pressed = false;
    if (app.uiHandle) app.sum = host_plugin_call(app.uiHandle, 0, 20, 22);
  }
  svc.close(); // root panel

  // bridged plugin fragments (draw after the core tree, same frame)
  for (var i = 0; i < uiPlugins.length; i++) {
    host_plugin_call(uiPlugins[i], 1, 0, 0); // FN_UI
  }
  return 0;
};

