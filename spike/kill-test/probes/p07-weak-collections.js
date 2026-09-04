// p07 — weak collections + Map ordering: DisposableList shape (Map + WeakMap), WeakRef, FinalizationRegistry.
// Grounded in cordis lib/index.js:4 (DisposableList), :962 (effectInertia), :636 (new WeakRef).
// GC-timing is NOT asserted: Hermes uses conservative stack scanning, so unreachable-but-on-stack
// objects may survive collection. Only deterministic semantics are tested here.
var __fails = 0;
var __log = typeof print === "function" ? print : console.log.bind(console);
var __r = globalThis.__report || {
  pass: (n) => __log("PASS " + n),
  fail: (n, d) => { __fails++; __log("FAIL " + n + " - " + d); },
  skip: (n, w) => __log("SKIP " + n + " - " + w),
  done: (n, f) => {
    __log("RESULT " + n + ": " + f + " failed");
    if (f > 0) {
      if (typeof quit === "function") quit(f);
      if (typeof process !== "undefined") process.exitCode = f;
    }
  }
};
function __assert(name, cond, detail) {
  if (cond) __r.pass(name); else __r.fail(name, detail || "assertion failed");
}

// DisposableList shape: Map for ordering + WeakMap for reverse lookup (cordis :4)
class __DisposableList {
  sn = 0;
  map = new Map();
  weak = new WeakMap();
  get length() { return this.map.size; }
  push(value) {
    const sn = ++this.sn;
    this.map.set(sn, value);
    this.weak.set(value, sn);
    return () => this.map.delete(sn);
  }
  delete(value) {
    const sn = this.weak.get(value);
    if (!sn) return false;
    return this.map.delete(sn);
  }
  clear() { const values = [...this.map.values()]; this.map.clear(); return values.reverse(); }
  [Symbol.iterator]() { return this.map.values(); }
}
const __list = new __DisposableList();
const __d1 = () => "d1";
const __d2 = () => "d2";
const __un1 = __list.push(__d1);
const __un2 = __list.push(__d2);
__assert("dlist-push", __list.length === 2);
__assert("dlist-weakmap-lookup", __list.delete(__d1) === true && __list.length === 1);
__assert("dlist-unregister", __un2() === true && __list.length === 0);
__list.push(() => {});
__list.push(() => {});
__assert("dlist-clear-reverses", (() => { const rev = __list.clear(); return rev.length === 2 && __list.length === 0; })());

// Map insertion-order iteration (cordis relies on this for disposal ordering)
const __m = new Map();
__m.set("k3", 3); __m.set("k1", 1); __m.set("k2", 2);
__m.set("k3", 33);
__assert("map-order", JSON.stringify([...__m.keys()]) === '["k3","k1","k2"]');
__assert("map-values-order", JSON.stringify([...__m.values()]) === "[33,1,2]");
__m.delete("k1"); __m.set("k1", 1);
__assert("map-reinsert-order", JSON.stringify([...__m.keys()]) === '["k3","k2","k1"]');
__assert("map-entries", (() => { const a = []; for (const [k, v] of __m) a.push(k + v); return a.join() === "k333,k22,k11"; })());

// WeakMap basics (deterministic parts)
const __k1 = {}, __k2 = {};
const __wm = new WeakMap();
__wm.set(__k1, "v1").set(__k2, "v2");
__assert("weakmap-get-has", __wm.get(__k1) === "v1" && __wm.has(__k2) && !__wm.has({}));
__assert("weakmap-delete", __wm.delete(__k1) === true && __wm.delete(__k1) === false && !__wm.has(__k1));
var __wmThrew = false;
try { __wm.set("string-key", 1); } catch (e) { __wmThrew = e instanceof TypeError; }
__assert("weakmap-rejects-primitives", __wmThrew);

// WeakRef: deterministic while strongly held (cordis Logger meta, :636)
const __fiber = { name: "root" };
const __ref = new WeakRef(__fiber);
__assert("weakref-deref-held", __ref.deref() === __fiber);
__assert("weakref-deref-type", __ref.deref() instanceof Object);

// FinalizationRegistry: construct + register (NO collection assertion — engine GC timing is
// nondeterministic under conservative stack scanning; record-only)
var __frOK = false;
try {
  const __fr = new FinalizationRegistry((held) => {});
  __fr.register({}, "tag");
  __frOK = true;
} catch (e) { __frOK = false; }
if (__frOK) __r.pass("finreg-construct-register"); else __r.fail("finreg-construct-register", "FinalizationRegistry unusable");

__r.done("p07-weak-collections", __fails);
