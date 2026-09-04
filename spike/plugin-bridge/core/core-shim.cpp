// core-shim.cpp — the core module's C half for M4.
//
// Exports (host calls, v0 contract):
//   core_init()                -> i32   init SH runtime + cordis, attach imports
//   core_load_plugin(handle)   -> i32   wrap bridged plugin as a cordis plugin
//   core_unload_plugin(handle) -> i32   dispose the fiber (teardown routed to host)
//   core_name_ptr()            -> i32   address of the service-name scratch buffer
//   core_name_len_set(len)     -> void  host sets the length after writing bytes
//
// Imports (implemented here as JSI host functions, called from AOT JS):
//   host_plugin_call(handle, fn, a, b) -> i32   routed to the host via EM_JS
//   host_plugin_dispose(handle)        -> i32
//   core_pending_name()                -> string (the scratch buffer contents)
//
// The host side lives in globalThis.__ededHost { pluginCall, pluginDispose }
// (namespaced per the M1 minified-glue gotcha), set before instantiation.
//
// Microtasks: cordis fiber start and dispose completion are microtasks; the
// shim drains SH's queue (hrt.drainMicrotasks()) after each entry point so
// callers observe effects synchronously on return.

#include "hermes/VM/static_h.h"
#include "hermes/hermes.h"
#include "jsi/jsi.h"
#include <emscripten.h>
#include <cstdint>
#include <cstring>

using namespace facebook;

extern "C" SHUnit *sh_export_this_unit(void);

static SHRuntime *g_shr = 0;
static int g_state = 0; // 0 = fresh, 1 = inited, -1 = disposed
static char g_name[64];
static int g_name_len = 0;

// --- C -> host -------------------------------------------------------------
EM_JS(int, host_plugin_call_js, (int handle, int fn, int a, int b), {
  return globalThis["__ededHost"].pluginCall(handle, fn, a, b);
});
EM_JS(int, host_plugin_dispose_js, (int handle), {
  return globalThis["__ededHost"].pluginDispose(handle);
});

// --- JSI host functions (the core's imported surface) -----------------------
static jsi::Value hfPluginCall(jsi::Runtime &rt, const jsi::Value &,
                               const jsi::Value *args, size_t count) {
  // JS side: host_plugin_call(handle, fn, a, b) — four arguments
  if (count < 4)
    return jsi::Value(-98);
  return jsi::Value(host_plugin_call_js((int)args[0].asNumber(),
                                        (int)args[1].asNumber(),
                                        (int)args[2].asNumber(),
                                        (int)args[3].asNumber()));
}

static jsi::Value hfPluginDispose(jsi::Runtime &rt, const jsi::Value &,
                                  const jsi::Value *args, size_t count) {
  if (count < 1)
    return jsi::Value(-98);
  return jsi::Value(host_plugin_dispose_js((int)args[0].asNumber()));
}

static jsi::Value hfPendingName(jsi::Runtime &rt, const jsi::Value &,
                                const jsi::Value *, size_t) {
  return jsi::String::createFromUtf8(rt, (const uint8_t *)g_name,
                                     (size_t)g_name_len);
}

static void attach(const char *name, int argCount, jsi::HostFunctionType fn) {
  auto &rt = *_sh_get_hermes_runtime(g_shr);
  rt.global().setProperty(
      rt, name,
      jsi::Function::createFromHostFunction(
          rt, jsi::PropNameID::forAscii(rt, name), argCount, fn));
}

// --- C entry points (AOT JS handlers called via JSI) ------------------------
static int call_core(const char *name, int handle, bool withArg) {
  auto &rt = *_sh_get_hermes_runtime(g_shr);
  auto fn = rt.global().getPropertyAsFunction(rt, name);
  jsi::Value res =
      withArg ? fn.call(rt, handle) : fn.call(rt);
  return res.isNumber() ? (int)res.asNumber() : -2;
}

extern "C" {

int core_init(void) {
  if (g_state != 0)
    return -10;
  g_shr = _sh_init(0, 0);
  if (!g_shr)
    return -11;
  if (!_sh_initialize_units(g_shr, 1, sh_export_this_unit)) {
    g_state = -1;
    return -12;
  }
  attach("host_plugin_call", 3, hfPluginCall);
  attach("host_plugin_dispose", 1, hfPluginDispose);
  attach("core_pending_name", 0, hfPendingName);
  int rc = call_core("eded_core_init", 0, false);
  if (rc == 0)
    g_state = 1;
  return rc;
}

int core_load_plugin(int handle) {
  if (g_state != 1)
    return -13;
  int rc = call_core("eded_core_load_plugin", handle, true);
  _sh_get_hermes_runtime(g_shr)->drainMicrotasks();
  return rc;
}

int core_unload_plugin(int handle) {
  if (g_state != 1)
    return -13;
  int rc = call_core("eded_core_unload_plugin", handle, true);
  _sh_get_hermes_runtime(g_shr)->drainMicrotasks();
  return rc;
}

// One-shot consumer: register an inject over the scratch-buffer-named service,
// drain (inject fires), then read the stored result. Synchronous on return.
int core_call_service(int fn, int a, int b) {
  if (g_state != 1)
    return -13;
  auto &rt = *_sh_get_hermes_runtime(g_shr);
  auto fnObj = rt.global().getPropertyAsFunction(rt, "eded_core_call_service");
  fnObj.call(rt, fn, a, b);
  rt.drainMicrotasks();
  return call_core("eded_core_call_service_result", 0, false);
}

int core_name_ptr(void) {
  return (int)(intptr_t)g_name;
}

void core_name_len_set(int len) {
  if (len >= 0 && len < (int)sizeof(g_name))
    g_name_len = len;
}

} // extern "C"
