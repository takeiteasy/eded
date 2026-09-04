// counter toy plugin (JS producer — the M3 pipeline generalized to plugins).
// Any JS-emitting tool works: this file is the whole "plugin source".
// The C shim (js-plugin.c) exposes the v0 wasm contract and forwards
// plugin_call into these globalThis handlers.
//
// Handler convention (i32-only v0):
//   eded_init() -> i32
//   eded_call(fn, a, b) -> i32   result value; < 0 = error
//   eded_dispose() -> i32
var count = 0;

globalThis.eded_init = function () {
  count = 0;
  return 0;
};

globalThis.eded_call = function (fn, a, b) {
  switch (fn) {
    case 0: count = a + b; return count; // add
    case 1: count = a * b; return count; // mul
    case 2: return count;                // get
    case 3: {
      var old = count;
      count = a;
      return old;
    }                                    // set -> old value
    default: return -1;                  // unknown fn
  }
};

globalThis.eded_dispose = function () {
  count = -1;
  return 0;
};
