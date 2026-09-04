// js-plugin.cpp — C shim bridging the v0 wasm plugin contract to AOT-compiled
// JS, via the JSI runtime that shermes exposes for every SHRuntime
// (_sh_get_hermes_runtime; the same mechanism the console bindings use).
//
// The plugin JS is compiled with -exported-unit=eded_plugin: the generated C
// exposes sh_export_eded_plugin() (an SHUnit creator) and no main. This shim
// exposes the wasm contract exports, initializes the SH runtime lazily from
// plugin_init, and forwards the contract calls to the JS handlers the plugin
// registers on globalThis at unit-init: eded_init/eded_call/eded_dispose.
// Every shermes-JS plugin links this same shim next to its generated C.
//
// NOTE: no C++ try/catch here — emscripten links noexcept libc++ by default
// and v0 handlers are total functions returning status codes. Error
// propagation across the boundary is contract-level (negative return), not
// exception-level.

#include "hermes/VM/static_h.h"
#include "hermes/hermes.h"
#include "jsi/jsi.h"

using namespace facebook;

extern "C" SHUnit *sh_export_eded_plugin(void);

static SHRuntime *g_shr = 0;
static int g_state = 0; // 0 = fresh, 1 = inited, -1 = disposed

static int call_number_global(const char *name, double a, double b, double c, int argc) {
  auto &rt = *_sh_get_hermes_runtime(g_shr);
  auto fn = rt.global().getPropertyAsFunction(rt, name);
  jsi::Value res = argc == 3 ? fn.call(rt, a, b, c) : fn.call(rt);
  return res.isNumber() ? (int)res.asNumber() : -2;
}

extern "C" {

int plugin_init(void) {
  if (g_state != 0)
    return -10;
  g_shr = _sh_init(0, 0);
  if (!g_shr)
    return -11;
  if (!_sh_initialize_units(g_shr, 1, sh_export_eded_plugin)) {
    g_state = -1;
    return -12;
  }
  int rc = call_number_global("eded_init", 0, 0, 0, 0);
  if (rc == 0)
    g_state = 1;
  return rc;
}

int plugin_call(int fn, int a, int b) {
  if (g_state != 1)
    return -13;
  return call_number_global("eded_call", fn, a, b, 3);
}

int plugin_dispose(void) {
  if (g_state != 1)
    return 0;
  int rc = call_number_global("eded_dispose", 0, 0, 0, 0);
  _sh_done(g_shr);
  g_shr = 0;
  g_state = -1;
  return rc;
}

} // extern "C"
