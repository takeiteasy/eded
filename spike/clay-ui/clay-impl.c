// clay-impl.c — clay linked in-core (M5). This single plain-C translation unit:
//   1. provides the CLAY_IMPLEMENTATION TU for the vendored clay v0.14 header,
//   2. implements the host-supplied text measure (monospace terminal metrics,
//      computed host-side through the scratch-f32 pattern),
//   3. installs clay's error handler (logged into JS-land, non-fatal),
//   4. implements the compact immediate-mode vocabulary the `layout` cordis
//      service (core-entry.js) calls into — pending-element state machine:
//      pending config setters -> clay_open() -> children -> clay_close().
//      The same backend backs the bridge plugin vocabulary (_vui), so in-core
//      and cross-bridge UI use one code path.
//
// Wire-format helpers (cmd_*/arr_*) export offsetof/sizeof values computed IN
// the real wasm build so the host-side render-command parser agrees with the
// build by construction, not by hand-derived arithmetic.
//
// All C++-side coupling stays in core-shim.cpp, which must NOT include
// clay.h (clay.h requires C++20 if included from C++; shim compiles as C++17).

#include <emscripten.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define CLAY_IMPLEMENTATION
#include "clay.h"

// --- layout constants shared with the host renderer (monospace terminal) ---
// CELL_W/CELL_H describe the terminal cell in clay "pixels"; the host measure
// import and the host ANSI painter both convert through these.
#define CELL_W 8
#define CELL_H 16

// --- clay arena -------------------------------------------------------------
// Static arena; BSS so it costs nothing in the wasm file and only reserves a
// slice of linear memory. Measured Clay_MinMemorySize() at default settings
// (v0.14) is ~4.9 MB — 8 MB covers it with headroom; the boot assert still
// guards the low end.
static uint8_t clay_memory[8 * 1024 * 1024] __attribute__((aligned(16)));

// --- shared scratch buffers -------------------------------------------------
// g_allbuf: general-purpose byte scratch (pending id strings + text). Written
// by the caller (core JS via the JSI wrapper, or host via HEAPU8) before the
// matching vocab call. 4 KB; demo strings are tiny.
// g_f32: two-float result scratch for the measure import (the generalized M4
// scratch-buffer pattern, now carrying a float pair back from the host).
static char g_allbuf[4096] __attribute__((aligned(16)));
static float g_f32[2] __attribute__((aligned(16)));

static int g_errors = 0;         // clay error count, surfaced for probes
static int g_measure_calls = 0;  // host-measure import fire counter

// temporary debug channel (bisect; remove when green)
EM_JS(void, clay_dbg_js, (int a, int b, int c), {
  console.log("DBG clay", a, b, c);
});

// --- frame output -----------------------------------------------------------
static int g_render_ptr = 0;
static int g_render_len = 0;

// --- error handler ----------------------------------------------------------
// Runs during Clay_EndLayout, i.e. deep inside the C frame path: it only
// reports, it must not disturb the open element stack.
EM_JS(void, clay_error_js, (int error_type, const char *chars, int len), {
  globalThis["__ededClay"].error(error_type, chars, len);
});

static void clay_error_handler(Clay_ErrorData error) {
  g_errors++;
  clay_error_js((int)error.errorType, error.errorText.chars, error.errorText.length);
}

// host text measure import (the plan's host-supplied text measure). The host
// writes {width, per-line-height} f32s into g_f32; C scales height by the
// number of '\n'-separated lines. Monospace terminal mode: the host measures
// at CELL_W per ASCII byte, CELL_H per line.
EM_JS(void, host_measure_js, (int ptr, int len, double max_w, int out_ptr), {
  globalThis["__ededHost"].measureText(ptr, len, max_w, out_ptr);
});

static Clay_Dimensions clay_measure_text(Clay_StringSlice text, Clay_TextElementConfig *config, void *userData) {
  (void)config; (void)userData;
  int lines = 1, line_bytes = 0, max_line_bytes = 0;
  for (int i = 0; i < text.length; i++) {
    if (text.chars[i] == '\n') {
      if (line_bytes > max_line_bytes) max_line_bytes = line_bytes;
      lines++;
      line_bytes = 0;
    } else {
      line_bytes++;
    }
  }
  if (line_bytes > max_line_bytes) max_line_bytes = line_bytes;
  g_measure_calls++;
  host_measure_js((int)(intptr_t)text.chars, max_line_bytes, 0.0, (int)(intptr_t)g_f32);
  clay_dbg_js(g_f32[0] * 10, g_f32[1] * 100, max_line_bytes); // temp bisect: w,h,n
  Clay_Dimensions d;
  d.width = g_f32[0];
  d.height = g_f32[1] * lines; // terminal mode: one cell row per line
  return d;
}

static Clay_Vector2 clay_query_scroll(uint32_t elementId, void *userData) {
  (void)elementId; (void)userData;
  Clay_Vector2 v = {0, 0};
  return v; // no scroll containers in the M5 spike
}

// --- boot -------------------------------------------------------------------
int clay_boot(float w, float h) {
  uint32_t min = Clay_MinMemorySize();
  if (min > sizeof(clay_memory)) return -20;
  Clay_Arena arena = Clay_CreateArenaWithCapacityAndMemory(min, clay_memory);
  Clay_ErrorHandler handler;
  handler.errorHandlerFunction = clay_error_handler;
  handler.userData = 0;
  Clay_Initialize(arena, (Clay_Dimensions){w, h}, handler);
  Clay_SetMeasureTextFunction(clay_measure_text, 0);
  // FIX: the scroll-query global stays NULL unless assigned, and a clip
  // element dereferences it below. Stub it unconditionally so any clip-driven
  // scroll state lookup stays total (M5 spike has no scrolling).
  Clay__QueryScrollOffset = clay_query_scroll;
  return 0;
}

// --- frame output -----------------------------------------------------------
// Pair convention: clay_build_frame() runs the JS UI build between
// clay_begin()/clay_output() — clay's immediate API expects BeginLayout
// BEFORE any element declarations (the open-element stack lives between them).
int clay_begin(void) {
  { // temp bisect
    Clay_Context *c = Clay_GetCurrentContext();
    clay_dbg_js(0x100, c->openLayoutElementStack.length, (int)(intptr_t)c->openLayoutElementStack.internalArray);
  }
  Clay_BeginLayout();
  return 0;
}

static inline int openStackLen(Clay_Context *c) { return c->openLayoutElementStack.length; }

int clay_output(void) {
  Clay_RenderCommandArray commands = Clay_EndLayout();
  g_render_ptr = (int)(intptr_t)commands.internalArray;
  g_render_len = commands.length;
  { // temp bisect: element/config counts + balanced-stack check
    Clay_Context *cctx = Clay_GetCurrentContext();
    clay_dbg_js(cctx->layoutElements.length, cctx->openLayoutElementStack.length, cctx->layoutElementTreeRoots.length);
  }
  return 0;
}

int clay_render_ptr(void) { return g_render_ptr; }
int clay_render_len(void) { return g_render_len; }

// --- pointer / dimensions ---------------------------------------------------
void clay_dimensions(float w, float h) { Clay_SetLayoutDimensions((Clay_Dimensions){w, h}); }

void clay_pointer(float x, float y, int down) {
  Clay_SetPointerState((Clay_Vector2){x, y}, down != 0);
}

// --- pending-element vocabulary ---------------------------------------------
// State: one pending Clay_ElementDeclaration + one pending text config. All
// setters write into them; clay_open() applies and clears; clay_close() pops.
static Clay_ElementDeclaration g_pending;
static Clay_TextElementConfig g_text_cfg;

void clay_reset_pending(void) {
  memset(&g_pending, 0, sizeof(g_pending));
  g_text_cfg = (Clay_TextElementConfig){0};
  g_text_cfg.textColor = (Clay_Color){255, 255, 255, 255};
  g_text_cfg.fontSize = 16;
  g_text_cfg.wrapMode = CLAY_TEXT_WRAP_NONE;
}

// id: bytes must already sit in g_allbuf, len supplied by the caller.
void clay_set_id(int len) {
  Clay_String s = {.length = len, .chars = g_allbuf};
  g_pending.id = Clay_GetElementId(s);
}

// sizing: each axis as (raw Clay__SizingType, value) — the JS layer sends the
// raw clay enum; value semantics follow the type (FIXED: exact, GROW: max
// clamp (0 = unbounded), PERCENT: 0..1, FIT: unused).
static Clay_SizingAxis sizing_axis(int t, float v) {
  Clay_SizingAxis a;
  memset(&a, 0, sizeof(a));
  if (t == 2) {
    a.type = CLAY__SIZING_TYPE_PERCENT;
    a.size.percent = v;
  } else if (t == 1) {
    a.type = CLAY__SIZING_TYPE_GROW;
    a.size.minMax = (Clay_SizingMinMax){0, v}; // v == 0: unbounded GROW
  } else if (t == 3) {
    a.type = CLAY__SIZING_TYPE_FIXED;
    a.size.minMax = (Clay_SizingMinMax){v, v};
  } else {
    a.type = CLAY__SIZING_TYPE_FIT; // value unused
  }
  return a;
}

void clay_set_layout(int wt, float wv, int ht, float hv, int pad_l, int pad_r,
                     int pad_t, int pad_b, int gap, int ax, int ay, int dir) {
  g_pending.layout.sizing.width = sizing_axis(wt, wv);
  g_pending.layout.sizing.height = sizing_axis(ht, hv);
  g_pending.layout.padding = (Clay_Padding){(uint16_t)pad_l, (uint16_t)pad_r, (uint16_t)pad_t, (uint16_t)pad_b};
  g_pending.layout.childGap = (uint16_t)gap;
  g_pending.layout.childAlignment = (Clay_ChildAlignment){(Clay_LayoutAlignmentX)ax, (Clay_LayoutAlignmentY)ay};
  g_pending.layout.layoutDirection = (Clay_LayoutDirection)dir;
}

void clay_set_bg(int rgba) {
  g_pending.backgroundColor = (Clay_Color){(float)((rgba >> 24) & 255), (float)((rgba >> 16) & 255),
                                           (float)((rgba >> 8) & 255), (float)(rgba & 255)};
}

void clay_set_border(int width, int rgba) {
  g_pending.border.color = (Clay_Color){(float)((rgba >> 24) & 255), (float)((rgba >> 16) & 255),
                                        (float)((rgba >> 8) & 255), (float)(rgba & 255)};
  g_pending.border.width = (Clay_BorderWidth){(uint16_t)width, (uint16_t)width, (uint16_t)width, (uint16_t)width, 0};
}

void clay_set_clip(int h, int v) {
  g_pending.clip.horizontal = h != 0;
  g_pending.clip.vertical = v != 0;
}

int clay_open(void) {
  { // temporary debug instrumentation (bisect; remove when green)
    Clay_Context *c = Clay_GetCurrentContext(); // declare Clay_LeanContext? use context API
    int len = c->openLayoutElementStack.length;
    int cap = c->openLayoutElementStack.capacity;
    int ptr = (int)(intptr_t)c->openLayoutElementStack.internalArray;
    clay_dbg_js(len, cap, ptr);
  }
  Clay__OpenElement();
  Clay__ConfigureOpenElementPtr(&g_pending);
  memset(&g_pending, 0, sizeof(g_pending)); // pending config is per-element
  return 0;
}

void clay_close(void) {
  { // temp bisect
    Clay_Context *cctx = Clay_GetCurrentContext();
    clay_dbg_js(0xFF00 | cctx->openLayoutElementStack.length, 0, 1);
  }
  Clay__CloseElement();
}

// text: bytes must already sit in g_allbuf (JSI wrapper copies JS strings
// there; the host copies bridge text there before routing _vui).
int clay_text(int len, int size, int fg, int wrap) {
  g_text_cfg.fontSize = (uint16_t)(size > 0 ? size : 16);
  g_text_cfg.wrapMode = wrap ? CLAY_TEXT_WRAP_NEWLINES : CLAY_TEXT_WRAP_NONE;
  g_text_cfg.textColor = (Clay_Color){(float)((fg >> 24) & 255), (float)((fg >> 16) & 255),
                                      (float)((fg >> 8) & 255), (float)(fg & 255)};
  Clay_String s = {.length = len, .chars = g_allbuf};
  Clay__OpenTextElement(s, &g_text_cfg);
  return 0;
}

// imperative hover query (one-frame latency by immediate-mode convention).
int clay_over(const char *id_bytes, int len) {
  Clay_ElementId id = Clay_GetElementId((Clay_String){.length = len, .chars = id_bytes});
  return Clay_PointerOver(id) ? 1 : 0;
}

// the hashed element id for bytes sitting anywhere in linear memory (the host
// writes candidate strings into g_allbuf and passes its address here).
int clay_id_of(const char *bytes, int len) {
  return (int)Clay_GetElementId((Clay_String){.length = len, .chars = bytes}).id;
}

// last frame's bounding box for a raw id, zeros if the id has no element.
// Lets probes locate elements without duplicating clay's id hashing in JS.
Clay_BoundingBox clay_bbox_of(int id) {
  Clay_ElementId eid = (Clay_ElementId){id, 0, 0, {0, 0}};
  Clay_ElementData data = Clay_GetElementData(eid);
  return data.boundingBox;
}

int clay_errors(void) { return g_errors; }
int clay_measure_calls(void) { return g_measure_calls; }
char *clay_allbuf_ptr(void) { return g_allbuf; }
int clay_id_of(const char *bytes, int len);

// --- bridge vocabulary (vui) --------------------------------------------------
// fn switch shared by the host bridge dispatcher (plugin fragments) and usable
// by core JS directly. Text bytes arrive in g_allbuf (host-copied from plugin
// memory — the M4 scratch-copy pattern generalized across the bridge).
enum { VUI_COLOR = 1, VUI_BOX = 2, VUI_TEXT = 3, VUI_END = 4 };

static int g_vui_bg = 0x303030ff; // plugin-fragment element background

int vui_color(int rgb) {
  g_vui_bg = rgb;
  return 0;
}

int vui_box(int w, int h) {
  clay_reset_pending();
  clay_set_layout(0, (float)w, 0, (float)h, 2, 2, 2, 2, 0, 0, 0, 1 /* column */);
  clay_set_bg(g_vui_bg);
  return clay_open();
}

int vui_text(int len, int size, int fg) { return clay_text(len, size, fg, 0); }

int vui_end(void) {
  Clay__CloseElement();
  return 0;
}

int vui(int fn, int a, int b) {
  switch (fn) {
    case VUI_COLOR: return vui_color(a);
    case VUI_BOX: return vui_box(a, b);
    case VUI_TEXT: return vui_text(b, 16, 0x22c55eff); // green text, size fixed for v0
    case VUI_END: return vui_end();
    default: return -99; // unknown vocab id
  }
}

// --- wire-format probes ------------------------------------------------------
// offsetof/sizeof values computed in this exact build; the host parser asserts
// its DataView offsets against these instead of trusting C ABI assumptions.
int cmd_size(void) { return (int)sizeof(Clay_RenderCommand); }
int cmd_box_off(void) { return (int)offsetof(Clay_RenderCommand, boundingBox); }
int cmd_data_off(void) { return (int)offsetof(Clay_RenderCommand, renderData); }
int cmd_user_off(void) { return (int)offsetof(Clay_RenderCommand, userData); }
int cmd_id_off(void) { return (int)offsetof(Clay_RenderCommand, id); }
int cmd_z_off(void) { return (int)offsetof(Clay_RenderCommand, zIndex); }
int cmd_type_off(void) { return (int)offsetof(Clay_RenderCommand, commandType); }
int cmd_text_len_off(void) { return (int)offsetof(Clay_RenderCommand, renderData.text.stringContents.length); }
int cmd_text_chars_off(void) { return (int)offsetof(Clay_RenderCommand, renderData.text.stringContents.chars); }
int cmd_text_color_off(void) { return (int)offsetof(Clay_RenderCommand, renderData.text.textColor); }
int cmd_rect_color_off(void) { return (int)offsetof(Clay_RenderCommand, renderData.rectangle.backgroundColor); }
int cmd_border_color_off(void) { return (int)offsetof(Clay_RenderCommand, renderData.border.color); }
int cmd_border_left_off(void) { return (int)offsetof(Clay_RenderCommand, renderData.border.width.left); }
int arr_len_off(void) { return (int)offsetof(Clay_RenderCommandArray, length); }
int arr_ptr_off(void) { return (int)offsetof(Clay_RenderCommandArray, internalArray); }
