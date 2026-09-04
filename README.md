# eded

A modular editor built on a WebAssembly core: cordis owns the plugin lifecycle,
clay owns layout, and the core contains no JS engine — the wisp runtime, cordis
and plugins are compiled ahead of time to wasm via Static Hermes. Renderer
backends (web canvas, sokol, termbox) are plugins that consume clay's render
commands through a platform-neutral host ABI.

## Status

Planning phase. The architecture, spike ladder and open questions live in
[docs/plan.md](docs/plan.md) — start there. Work is tracked on the tracker
(~takeiteasy/eded).

## Related projects

- [wisp2](https://git.sr.ht/~takeiteasy/wisp) — the wisp compiler. Independent
  of eded; it feeds compiled JS (wisp plugins, eventually the runtime itself)
  into eded's AOT pipeline.
