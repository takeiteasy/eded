// M4 core entry: cordis stays in-core; each host-instantiated plugin module is
// wrapped as an ARROW function plugin (isConstructor-safe, M3 p6) whose body
// provides the service named by the host-written scratch buffer and routes
// calls across the host bridge. The host writes the name bytes into core
// memory (core_name_ptr/len) before calling core_load_plugin.
//
// host_plugin_call / host_plugin_dispose / core_pending_name are JSI host
// functions attached by core-shim.cpp at core_init().

import { Context } from "@deepseek-ai/cordis";

var ctx = null;
var fibers = {}; // handle -> fiber

globalThis.eded_core_init = function () {
  ctx = new Context();
  fibers = {};
  return 0;
};

globalThis.eded_core_load_plugin = function (handle) {
  if (!ctx) return -14;
  if (fibers[handle]) return -15; // already loaded
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
  return 0;
};

globalThis.eded_core_unload_plugin = function (handle) {
  var fiber = fibers[handle];
  if (!fiber) return -1;
  delete fibers[handle];
  fiber.dispose();
  return 0;
};

// Spike consumer surface: inject the service named by the scratch buffer and
// call it once. The shim drains microtasks after this returns, then reads
// eded_core_call_service_result, so the host observes the value synchronously.
var lastResult = -96; // sentinel: inject not fired

globalThis.eded_core_call_service = function (fn, a, b) {
  var name = core_pending_name();
  lastResult = -96; // sentinel: reset per call so post-unload misses are observable
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
