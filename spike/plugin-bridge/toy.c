// toy.c — eded v0 plugin contract, freestanding C.
// This is the "foreign module" witness: any toolchain that emits core wasm
// with these exports is a valid eded plugin. No runtime, no imports.
//
// Contract (M4, i32-only v0; see FINDINGS.md):
//   plugin_init() -> i32                          0 = ok
//   plugin_call(fn: i32, a: i32, b: i32) -> i32   result value; < 0 = error
//   plugin_dispose() -> i32                       0 = ok
static int state = 0;

int plugin_init(void) {
  state = 0;
  return 0;
}

int plugin_call(int fn, int a, int b) {
  switch (fn) {
    case 0: state = a + b; return state; // add
    case 1: state = a * b; return state; // mul
    case 2: return state;                // get
    case 3: {
      int old = state;
      state = a;
      return old;
    }                                    // set -> old value
    default: return -1;                  // unknown fn
  }
}

int plugin_dispose(void) {
  state = -1;
  return 0;
}
