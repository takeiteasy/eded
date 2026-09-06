// core-shim.cpp — the core module's C half for M5.
//
// M4 surface (unchanged semantics):
//   core_init / core_load_plugin / core_unload_plugin / core_call_service /
//   core_name_ptr / core_name_len_set  (arrow-wrapped bridge plugins, scratch
//   buffer, drainMicrotasks after lifecycle entry points)
//
// M5 additions:
//   exports: core_dimensions(w,h)   -> clay layout dimensions (before frame)
//            core_pointer(x,y,down)-> clay pointer state
//            core_frame()          -> JS UI build (eded_ui_frame) + clay layout
//            core_render_ptr()     -> RenderCommandArray.internalArray addr
//            core_render_len()     -> RenderCommandArray.length
//            vui(fn, a, b)         -> bridge vocabulary dispatch (plugin UI)
//            cmd_* / arr_*         -> wire offset values for the host parser
//   imports: host_measure_text(ptr, len, maxW, outPtr)  — host-supplied text
//            measure, results land in a core f32 scratch pair.
//
// FRAME SYNCHRONY (invariant 3): core_frame is one synchronous host call. It
// does NOT drain microtasks; no cordis fiber starts inside the frame path (the
// bridge's lifecycle work stays on load/unload, which drain as in M4).
//
// C++/clay split: clay.h demands C++20, so ALL clay-facing code lives in
// clay-impl.c (C99) — this TU only declares its extern "C" surface.

#include "hermes/VM/static_h.h"
#include "hermes/hermes.h"
#include "jsi/jsi.h"
#include <emscripten.h>
#include <cstdint>
#include <cstring>

using namespace facebook;

extern "C" SHUnit *sh_export_this_unit(void);

// --- clay-impl.c surface (signatures MUST match clay-impl.c exactly) --------
extern "C" {
int clay_boot(float w, float h);
void clay_dimensions(float w, float h);
void clay_pointer(float x, float y, int down);
int clay_begin(void);
int clay_output(void);
int clay_render_ptr(void);
int clay_render_len(void);
void clay_reset_pending(void);
void clay_set_id(int len);
void clay_set_layout(int, float, int, float, int, int, int, int, int, int, int, int);
void clay_set_bg(int rgba);
void clay_set_border(int width, int rgba);
void clay_set_clip(int h, int v);
int clay_open(void);
void clay_close(void);
int clay_text(int len, int size, int fg, int wrap);
int clay_over(const char *id_bytes, int len);
char *clay_allbuf_ptr(void);
int clay_errors(void);
int clay_measure_calls(void);
int clay_id_of(const char *bytes, int len);
int vui(int fn, int a, int b);
}

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

// --- clay vocabulary wrappers (called from core AOT JS) ----------------------
// Byte-transfer convention: JS hands a JSI string; the shim copies its bytes
// into the shared g_allbuf and returns the authoritative byte count. The
// follow-up call (clay_set_id / vui_text path) receives just that count.

static jsi::Value hfClayBuf(jsi::Runtime &rt, const jsi::Value &,
                            const jsi::Value *args, size_t count) {
  if (count < 1 || !args[0].isString())
    return jsi::Value(-98);
  auto s = args[0].asString(rt).utf8(rt);
  if (s.size() >= 4096)
    s.resize(4095);
  memcpy(clay_allbuf_ptr(), s.data(), s.size());
  return jsi::Value((int)s.size());
}

static jsi::Value hfClaySetId(jsi::Runtime &rt, const jsi::Value &,
                              const jsi::Value *args, size_t count) {
  if (count < 1)
    return jsi::Value(-98);
  clay_set_id((int)args[0].asNumber());
  return jsi::Value(0);
}

static jsi::Value hfClayLayout(jsi::Runtime &, const jsi::Value &,
                               const jsi::Value *args, size_t count) {
  if (count < 12)
    return jsi::Value(-98);
  clay_set_layout((int)args[0].asNumber(), (float)args[1].asNumber(),
                  (int)args[2].asNumber(), (float)args[3].asNumber(),
                  (int)args[4].asNumber(), (int)args[5].asNumber(),
                  (int)args[6].asNumber(), (int)args[7].asNumber(),
                  (int)args[8].asNumber(), (int)args[9].asNumber(),
                  (int)args[10].asNumber(), (int)args[11].asNumber());
  return jsi::Value(0);
}

static jsi::Value hfClayBg(jsi::Runtime &, const jsi::Value &,
                           const jsi::Value *args, size_t count) {
  if (count < 1)
    return jsi::Value(-98);
  clay_set_bg((int)args[0].asNumber());
  return jsi::Value(0);
}

static jsi::Value hfClayBorder(jsi::Runtime &, const jsi::Value &,
                               const jsi::Value *args, size_t count) {
  if (count < 2)
    return jsi::Value(-98);
  clay_set_border((int)args[0].asNumber(), (int)args[1].asNumber());
  return jsi::Value(0);
}

static jsi::Value hfClayClip(jsi::Runtime &, const jsi::Value &,
                             const jsi::Value *args, size_t count) {
  if (count < 2)
    return jsi::Value(-98);
  clay_set_clip((int)args[0].asNumber(), (int)args[1].asNumber());
  return jsi::Value(0);
}

static jsi::Value hfClayReset(jsi::Runtime &, const jsi::Value &,
                              const jsi::Value *, size_t) {
  clay_reset_pending();
  return jsi::Value(0);
}

static jsi::Value hfClayOpen(jsi::Runtime &, const jsi::Value &,
                             const jsi::Value *, size_t) {
  return jsi::Value(clay_open());
}

static jsi::Value hfClayClose(jsi::Runtime &, const jsi::Value &,
                              const jsi::Value *, size_t) {
  clay_close();
  return jsi::Value(0);
}

static jsi::Value hfClayText(jsi::Runtime &, const jsi::Value &,
                             const jsi::Value *args, size_t count) {
  if (count < 4)
    return jsi::Value(-98);
  clay_text((int)args[0].asNumber(), (int)args[1].asNumber(),
            (int)args[2].asNumber(), (int)args[3].asNumber());
  return jsi::Value(0);
}

static jsi::Value hfClayOver(jsi::Runtime &rt, const jsi::Value &,
                             const jsi::Value *args, size_t count) {
  if (count < 1 || !args[0].isString())
    return jsi::Value(-98);
  auto s = args[0].asString(rt).utf8(rt);
  if (s.size() >= 4096)
    s.resize(4095);
  memcpy(clay_allbuf_ptr(), s.data(), s.size());
  return jsi::Value(clay_over(clay_allbuf_ptr(), (int)s.size()));
}

// core JS console substitute (no console in the AOT runtime; M4 core code
// simply never logs — M5 frame telemetry goes through here instead)
EM_JS(void, host_log_js, (const char *bytes, int len), {
  console.error(UTF8ToString(bytes, len));
});
EM_JS_DEPS(host_log, "$UTF8ToString");

static jsi::Value hfLog(jsi::Runtime &rt, const jsi::Value &,
                        const jsi::Value *args, size_t count) {
  if (count < 1 || !args[0].isString())
    return jsi::Value(-98);
  auto s = args[0].asString(rt).utf8(rt);
  host_log_js(s.c_str(), (int)s.size());
  return jsi::Value(0);
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

static void call_void3(const char *name, double a, double b, int c) {
  auto &rt = *_sh_get_hermes_runtime(g_shr);
  auto fn = rt.global().getPropertyAsFunction(rt, name);
  fn.call(rt, a, b, c);
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
  if (clay_boot(640.0f, 400.0f) != 0)
    return -21;
  attach("host_plugin_call", 3, hfPluginCall);
  attach("host_plugin_dispose", 1, hfPluginDispose);
  attach("core_pending_name", 0, hfPendingName);
  attach("clay_buf", 1, hfClayBuf);
  attach("clay_set_id", 1, hfClaySetId);
  attach("clay_layout", 12, hfClayLayout);
  attach("clay_bg", 1, hfClayBg);
  attach("clay_border", 2, hfClayBorder);
  attach("clay_clip", 2, hfClayClip);
  attach("clay_reset", 0, hfClayReset);
  attach("clay_open", 0, hfClayOpen);
  attach("clay_close", 0, hfClayClose);
  attach("clay_text", 4, hfClayText);
  attach("clay_over", 1, hfClayOver);
  attach("host_log", 1, hfLog);
  int rc = call_core("eded_core_init", 0, false);
  if (rc == 0) {
    _sh_get_hermes_runtime(g_shr)->drainMicrotasks(); // service fibers start as microtasks
    g_state = 1;
  }
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

// --- M5 frame surface --------------------------------------------------------
int core_dimensions(double w, double h) {
  if (g_state != 1)
    return -13;
  clay_dimensions((float)w, (float)h);
  return 0;
}

int core_pointer(double x, double y, int down) {
  if (g_state != 1)
    return -13;
  clay_pointer((float)x, (float)y, down);
  call_void3("eded_pointer", x, y, down);
  return 0;
}

int core_frame(double dt_ms) {
  if (g_state != 1)
    return -13;
  clay_begin(); // open the root container BEFORE any JS declarations
  int rc = call_core("eded_ui_frame", (int)(dt_ms * 1000.0), true);
  if (rc != 0)
    return rc;
  return clay_output(); // end layout; sync, no microtask draining
}

int core_render_ptr(void) { return clay_render_ptr(); }
int core_render_len(void) { return clay_render_len(); }
int vui_dispatch(int fn, int a, int b) { return vui(fn, a, b); }

int core_name_ptr(void) {
  return (int)(intptr_t)g_name;
}

void core_name_len_set(int len) {
  if (len >= 0 && len < (int)sizeof(g_name))
    g_name_len = len;
}

} // extern "C"
