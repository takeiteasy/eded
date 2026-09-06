// plugin-ui.js — the M5 UI-declaration probe (JS producer; M3 pipeline).
// FN 0 is the M4 counter service (add/mul/get/set); FN 1 draws this plugin's
// per-frame UI fragment by answering the core's ui call with vui(...) calls
// across the host bridge — the "per-frame immediate clay calls across the ABI"
// contract option, at toy scale. Strings cross via eded_text + eded_vocab
// (FG_TEXT): the host copies them from plugin memory into core scratch before
// routing the call (M4 scratch-copy pattern generalized across the bridge).
//
// vui ids (clay-impl.c): 1=COLOR(bg) 2=BOX(w,h) 3=TEXT(len) 4=END(close)
var count = 0;

globalThis.eded_init = function () {
  count = 0;
  return 0;
};

function ui() {
  eded_vocab(1, 0x1e3a5fff, 0); // COLOR: deep blue panel bg
  eded_vocab(2, 240, 30);       // BOX 240x30
  var ptr = eded_text("ui: plugin fragment (vocab over bridge)");
  eded_vocab(3, ptr, eded_text_len()); // TEXT from my linear memory
  eded_vocab(4, 0, 0);          // END: close panel
}

globalThis.eded_call = function (fn, a, b) {
  switch (fn) {
    case 0: count = a + b; return count; // add (bridged service call)
    case 1: ui(); return 0;              // FN_UI: per-frame fragment
    case 2: return count;
    default: return -1;
  }
};

globalThis.eded_dispose = function () {
  count = -1;
  return 0;
};
