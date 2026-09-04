// eded JS-library overrides for the shermes wasm pipeline.
//
// $randomFill: upstream emscripten (6.0.2 libwasi.js) calls
// crypto.getRandomValues(view) directly on a view into the wasm heap. The
// WebCrypto spec rejects views backed by resizable buffers, and the heap is
// resizable under ALLOW_MEMORY_GROWTH — so every browser host aborts at
// runtime init when the VM seeds its RNG (node is unaffected: its backend is
// crypto.randomBytes). Upstream already works around this for SHARED_MEMORY
// builds; mirror that workaround for plain growth builds, chunked at 64 KiB
// (WebCrypto's per-call limit).
mergeInto(LibraryManager.library, {
  $randomFill: (view) => {
    for (let off = 0; off < view.length; off += 65536) {
      const n = Math.min(65536, view.length - off);
      view.set(crypto.getRandomValues(new Uint8Array(n)), off);
    }
    return 0;
  },
});
