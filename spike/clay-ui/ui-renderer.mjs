// ui-renderer.mjs — the M5 host-side terminal renderer (node rung).
// Consumes the Clay_RenderCommandArray out of core wasm memory (host parses
// the wire format via offsets exported from the build), paints into a cell
// buffer, and flushes only changed cells as truecolor ANSI. Structure cribbed
// from clay's upstream renderers/termbox2 (cell buffer + diff flush) and
// renderers/terminal (command semantics); no termbox dependency.
//
// Spike simplification (documented; revisit at ticket #2's renderer contract):
// one terminal cell = one monospace glyph, so fontSize is decorative — every
// text run paints one char per cell at CELL_W/CELL_H. RECTANGLE fills bg
// color; BORDER draws edge glyphs; IMAGE/CUSTOM are skipped (probes assert
// none appear).

export const CELL_W = 8;
export const CELL_H = 16;

// wire command types (Clay_RenderCommandType order in clay.h v0.14)
export const RC = { NONE: 0, RECTANGLE: 1, BORDER: 2, TEXT: 3, IMAGE: 4, SCISSOR_START: 5, SCISSOR_END: 6, CUSTOM: 7 };

// --- decls for probe-free parse: offsets come from the core's own exports ---
export function buildOffsets(core) {
  return {
    size: core._cmd_size(),
    box: core._cmd_box_off(),
    type: core._cmd_type_off(),
    id: core._cmd_id_off(),
    textLen: core._cmd_text_len_off(),
    textChars: core._cmd_text_chars_off(),
    textColor: core._cmd_text_color_off(),
    rectColor: core._cmd_rect_color_off(),
    borderColor: core._cmd_border_color_off(),
    borderLeft: core._cmd_border_left_off(),
  };
}

// parse in-order paint commands out of core memory
export function parseCommands(core, ptr, len, off) {
  const heap = core.HEAPU8;
  const dv = new DataView(heap.buffer);
  const cmdSize = off.size;
  const fit = Math.max(0, Math.floor((heap.buffer.byteLength - ptr) / cmdSize));
  len = Math.min(len, fit);
  const out = [];
  for (let i = 0; i < len; i++) {
    const base = ptr + i * cmdSize;
    const cmd = {
      type: dv.getUint8(base + off.type),
      id: dv.getUint32(base + off.id, true),
      x: dv.getFloat32(base + off.box, true),
      y: dv.getFloat32(base + off.box + 4, true),
      w: dv.getFloat32(base + off.box + 8, true),
      h: dv.getFloat32(base + off.box + 12, true),
    };
    if (cmd.type === RC.TEXT) {
      const tlen = dv.getInt32(base + off.textLen, true);
      const tptr = dv.getInt32(base + off.textChars, true);
      const end = Math.min(tptr + tlen, heap.length);
      cmd.text = tptr >= 0 && end > tptr ? latin1(heap.subarray(tptr, end)) : "";
      cmd.fg = rgba(dv, base + off.textColor);
    } else if (cmd.type === RC.RECTANGLE) {
      cmd.bg = rgba(dv, base + off.rectColor);
    } else if (cmd.type === RC.BORDER) {
      cmd.color = rgba(dv, base + off.borderColor);
      cmd.borderLeft = dv.getUint16(base + off.borderLeft, true);
    }
    out.push(cmd);
  }
  return out;
}

function rgba(dv, at) {
  return [0, 1, 2, 3].map((k) => dv.getFloat32(at + k * 4, true));
}

function latin1(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

// --- cell buffer + ANSI diff writer ------------------------------------------
export class Screen {
  constructor(out) {
    this.out = out;
    this.cols = 0;
    this.rows = 0;
    this.first = true; // next flush paints everything
    this.ch = null; this.fg = null; this.bg = null;
    this.p_ch = null; this.p_fg = null; this.p_bg = null;
  }
  resize(cols, rows) {
    this.cols = cols; this.rows = rows;
    const n = cols * rows;
    this.ch = new Uint16Array(n);
    this.fg = new Uint32Array(n);
    this.bg = new Uint32Array(n);
    this.p_ch = new Uint16Array(n);
    this.p_fg = new Uint32Array(n);
    this.p_bg = new Uint32Array(n);
    this.first = true;
  }
  set(x, y, ch, fg, bg, clip) {
    x |= 0; y |= 0;
    if (clip && (x < clip[0] || x >= clip[2] || y < clip[1] || y >= clip[3])) return;
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return;
    const i = y * this.cols + x;
    if (bg !== null && bg !== undefined && bg !== 0) { this.bg[i] = bg | 0; this.ch[i] = ch !== 0 ? ch : 0x20; }
    if (ch !== 0) this.ch[i] = ch;
    if (fg) this.fg[i] = fg | 0;
  }
  // paint the parsed command array in order (clay z-sorts it already)
  paint(cmds) {
    this.ch.fill(0x20);
    this.bg.fill(0x0f0f14);
    this.fg.fill(0x9ca3af);
    let clip = null;
    for (const c of cmds) {
      const x = Math.round(c.x / CELL_W), y = Math.round(c.y / CELL_H);
      const w = Math.round(c.w / CELL_W), h = Math.round(c.h / CELL_H);
      switch (c.type) {
        case RC.SCISSOR_START: clip = [x, y, x + w, y + h]; break;
        case RC.SCISSOR_END: clip = null; break;
        case RC.RECTANGLE:
          if (c.bg && (c.bg[3] | 0) > 0) this.fillRect(x, y, w, h, c.bg, clip);
          break;
        case RC.TEXT: {
          let cx = x;
          for (let k = 0; k < c.text.length; k++) {
            const ch = c.text.charCodeAt(k);
            if (ch === 10) { cx = x; continue; } // v0: wrap disabled; be safe
            this.set(cx++, y, ch, fgTo(c.fg), 0, clip);
          }
          break;
        }
        case RC.BORDER:
          if ((c.borderLeft | 0) > 0) this.frame(x, y, w, h, c.color, clip);
          break;
        default: break; // IMAGE/CUSTOM: absent from the demo tree
      }
    }
  }
  fillRect(x, y, w, h, bg, clip) {
    const b = bgTo(bg);
    for (let ry = 0; ry < h; ry++)
      for (let rx = 0; rx < w; rx++)
        this.set(x + rx, y + ry, 0, 0, b, clip);
  }
  frame(x, y, w, h, color, clip) {
    const c = rgbOf(color);
    const E = 0x2500, V = 0x2502, TL = 0x250c, TR = 0x2510, BL = 0x2514, BR = 0x2518;
    for (let rx = 0; rx < w; rx++) { this.set(x + rx, y, E, c, 0, clip); this.set(x + rx, y + h - 1, E, c, 0, clip); }
    for (let ry = 0; ry < h; ry++) { this.set(x, y + ry, V, c, 0, clip); this.set(x + w - 1, y + ry, V, c, 0, clip); }
    this.set(x, y, TL, c, 0, clip);
    this.set(x + w - 1, y, TR, c, 0, clip);
    this.set(x, y + h - 1, BL, c, 0, clip);
    this.set(x + w - 1, y + h - 1, BR, c, 0, clip);
  }
  // write only cells whose (ch, fg, bg) changed since the previous flush
  flush() {
    const W = this.cols, H = this.rows;
    const pieces = [];
    for (let y = 0; y < H; y++) {
      let x = 0;
      while (x < W) {
        const i = y * W + x;
        if (!this.first && this.ch[i] === this.p_ch[i] && this.fg[i] === this.p_fg[i] && this.bg[i] === this.p_bg[i]) { x++; continue; }
        // start a run: scan ahead while cells share fg+bg and differ from prev
        const fg = this.fg[i], bg = this.bg[i];
        let end = x;
        while (end < W) {
          const j = y * W + end;
          if (this.fg[j] !== fg || this.bg[j] !== bg) break;
          if (!this.first && this.ch[j] === this.p_ch[j] && this.fg[j] === this.p_fg[j] && this.bg[j] === this.p_bg[j]) break;
          end++;
        }
        pieces.push(`\x1b[${y + 1};${x + 1}H${sgr(fg, bg)}`);
        for (let rx = x; rx < end; rx++) {
          const j = y * W + rx;
          pieces.push(String.fromCharCode(this.ch[j]));
          this.p_ch[j] = this.ch[j];
          this.p_fg[j] = this.fg[j];
          this.p_bg[j] = this.bg[j];
        }
        x = end;
      }
    }
    if (pieces.length) this.out.write(pieces.join(""));
    this.first = false;
  }
}

function rgbOf(c) {
  return (clamp255(c[0]) << 16) | (clamp255(c[1]) << 8) | clamp255(c[2]);
}
const clamp255 = (v) => Math.max(0, Math.min(255, v | 0));
function fgTo(c) { // [r,g,b,a] floats -> fg cell rgb (a folded over terminal bg)
  const a = clamp255(c[3]) / 255;
  if (a >= 0.98) return rgbOf(c);
  return foldOverTerminal(c, a);
}
function bgTo(c) {
  const a = clamp255(c[3]) / 255;
  if (a >= 0.999) return rgbOf(c);
  return foldOverTerminal(c, a);
}
function foldOverTerminal(c, a) {
  const T = [0x0f, 0x0f, 0x14]; // demo terminal background
  return (Math.round(T[0] * (1 - a) + clamp255(c[0]) * a) << 16) |
         (Math.round(T[1] * (1 - a) + clamp255(c[1]) * a) << 8) |
         Math.round(T[2] * (1 - a) + clamp255(c[2]) * a);
}
function sgr(fg, bg) {
  let s = "";
  if (fg >= 0) s += `\x1b[38;2;${(fg >> 16) & 255};${(fg >> 8) & 255};${fg & 255}m`;
  else s += `\x1b[39m`;
  if (bg >= 0 && bg !== -1) s += `\x1b[48;2;${(bg >> 16) & 255};${(bg >> 8) & 255};${bg & 255}m`;
  return s;
}

// --- ANSI terminal session ----------------------------------------------------
export function enterTui(out) {
  out.write("\x1b[?1049h\x1b[?25l"); // alt screen + hide cursor
  out.write("\x1b[?1003h\x1b[?1006h"); // any-motion mouse + SGR encoding
  out.write("\x1b[2J\x1b[H");
}
export function leaveTui(out) {
  out.write("\x1b[0m");
  out.write("\x1b[?1006l\x1b[?1003l\x1b[?1000l"); // mouse off
  out.write("\x1b[?25h\x1b[?1049l"); // cursor + main screen
}

// minimal SGR-mouse + key decoder: returns {type: 'move'|'down'|'up'|'key', x, y, key}
// cell coords are 1-based from the terminal; returns 0-based cell coords for the host.
export function decodeInput(chunk) {
  const s = chunk.toString("latin1");
  const events = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b" && s[i + 1] === "<") {
      const m = /^[\x1b]?[\[<](\d+);(\d+);(\d+)([Mm])/.exec(s.slice(i));
      if (m) {
        const btn = +m[1], x = +m[2] - 1, y = +m[3] - 1;
        const press = m[4] === "M";
        const kind = btn & 32 ? "move" : press ? "down" : "up";
        if ((btn & 3) === 0 || kind === "move") events.push({ type: kind, x, y });
        i += m[0].length;
        continue;
      }
    }
    const ch = s[i];
    if (ch === "\x1b" && s[i + 1] === "[" && !/\d/.test(s[i + 2] || "")) {
      i += 2; // consume a simple CSI sequence we don't handle
      continue;
    }
    if (ch === "\r") events.push({ type: "key", key: "enter" });
    else if (ch === "\x03" || ch === "q" || ch === "Q") events.push({ type: "key", key: "quit" });
    else if (ch === "\x7f" || (ch >= " " && ch < "\x7f")) events.push({ type: "key", key: ch === "\x1b" ? "esc" : ch });
    i++;
  }
  return events;
}
