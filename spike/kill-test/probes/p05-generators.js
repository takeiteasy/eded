// p05 — sync generators + iterator protocol (cordis uses GeneratorFunction identity + generator exclusion).
// NOTE: async generators are a shermes compile-level REJECTION (preflight) — recorded in FINDINGS;
// M3 mitigates by bundling with esbuild --target=es2017 which lowers them to sync generators + promises.
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
__r.skip("p05-async-generators", "shermes rejects async function* at compile time; cordis bundle contains one — mitigation (esbuild lowering) lands in M3");

function* __counter(n) {
  for (let i = 1; i <= n; i++) yield i;
}
const __collected = [];
for (const v of __counter(3)) __collected.push(v);
__assert("gen-for-of", JSON.stringify(__collected) === "[1,2,3]");

// manual iterator protocol
const __it = __counter(2);
__assert("gen-next", __it.next().value === 1 && __it.next().value === 2 && __it.next().done === true);

// yield* delegation
function* __delegating() { yield 0; yield* __counter(2); yield 9; }
__assert("gen-yield-star", JSON.stringify([...__delegating()]) === "[0,1,2,9]");

// generator return/finally
function* __abortable() {
  try { yield 1; yield 2; } finally { __abortable.ran = true; }
}
__abortable.ran = false;
const __it2 = __abortable();
__it2.next();
__it2.return("stop");
__assert("gen-return-finally", __abortable.ran === true);

// early break in for-of triggers finally
__abortable.ran = false;
for (const v of __abortable()) { break; }
__assert("gen-break-finally", __abortable.ran === true);

// custom iterator object (cordis DisposableList uses [Symbol.iterator] returning map.values())
const __bag = {
  items: ["a", "b"],
  [Symbol.iterator]() { return this.items.values(); }
};
__assert("custom-iterator", JSON.stringify([...__bag]) === '["a","b"]' && "a" in {} === false);
__assert("map-values-iterator", (() => {
  const m = new Map([[1, "x"], [2, "y"]]);
  const vi = m.values();
  return vi.next().value === "x" && vi.next().value === "y" && vi.next().done === true;
})());

// generator object shape: next/return/throw present
const __it3 = __counter(1);
__assert("gen-shape", typeof __it3.next === "function" && typeof __it3.return === "function" && typeof __it3.throw === "function");
__assert("gen-not-ctor", __it3.prototype === undefined);

// generator throwing propagates
function* __boom() { yield 1; throw new Error("gen-boom"); }
const __it4 = __boom();
__it4.next();
var __genErr = null;
try { __it4.next(); } catch (e) { __genErr = e; }
__assert("gen-throw", __genErr instanceof Error && __genErr.message === "gen-boom");

__r.done("p05-generators", __fails);
