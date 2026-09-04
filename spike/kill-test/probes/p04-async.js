// p04 — async/await: chains, Promise.all/allSettled, rejection propagation, ordering, custom thenables.
// Grounded in cordis fiber effects (lib/index.js:1155, :1215, :1274 custom .then wrapper).
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

var __order = [];

(async () => {
  // microtask ordering: sync code, then promise callbacks in registration order
  __order.push("sync1");
  Promise.resolve().then(() => __order.push("micro1"));
  __order.push("sync2");
  await Promise.resolve();
  __order.push("after-await1");

  // await chains + values
  async function __depth2() { return 21; }
  async function __depth1() { const v = await __depth2(); return v * 2; }
  __assert("await-chain", (await __depth1()) === 42);

  // Promise.all
  async function __slow(v, ms) { await Promise.resolve(); return v; }
  const __all = await Promise.all([__slow(1), __slow(2), __slow(3)]);
  __assert("promise-all", JSON.stringify(__all) === "[1,2,3]");

  // Promise.allSettled (cordis uses it in events.parallel + unload, :272, :816)
  const __settled = await Promise.allSettled([Promise.resolve(1), Promise.reject(new Error("boom"))]);
  __assert("allsettled", __settled[0].status === "fulfilled" && __settled[0].value === 1 && __settled[1].status === "rejected" && __settled[1].reason.message === "boom");

  // rejection propagation through try/catch across awaits
  async function __fails2() { throw new Error("delayed"); }
  var __caught = null;
  try { await __fails2(); } catch (e) { __caught = e; }
  __assert("rejection-caught", __caught instanceof Error && __caught.message === "delayed");

  // async IIFE + then ordering (cordis effect start pattern)
  __order.push("sync3");
  const __p = (async () => { await Promise.resolve(); __order.push("iife"); return "ok"; })();
  __order.push("sync4");
  __assert("iife-returns-promise", __p instanceof Promise);
  __assert("iife-result", (await __p) === "ok");
  __order.push("after-iife");

  // custom thenable: plain object with .then = async fn (cordis effect wrapper, :1274)
  var __task = Promise.resolve("task");
  var __wrapper = {};
  var __disposeCalled = [];
  __wrapper.then = async (onFulfilled, onRejected) => {
    return Promise.resolve(__task).then(() => "disposed").then(onFulfilled, onRejected);
  };
  __assert("thenable-await", (await __wrapper) === "disposed");

  // Promise resolve of a thenable chains through
  __assert("thenable-promise", (await Promise.resolve(__wrapper)) === "disposed");

  // ordering assertions — standard microtask semantics
  __assert("order-sync-first", __order.slice(0, 2).join() === "sync1,sync2" && __order[2] === "micro1");
  __assert("order-await-resumes", __order[3] === "after-await1");
  __assert("order-iife", __order.indexOf("sync3") < __order.indexOf("sync4") && __order.indexOf("iife") > __order.indexOf("sync4") && __order.indexOf("after-iife") > __order.indexOf("iife"), __order.join(","));

  // sequential awaits (cordis events.serial, :289)
  const __serial = [];
  for (const v of [1, 2, 3]) { const r = await Promise.resolve(v * 10); __serial.push(r); }
  __assert("serial-await", JSON.stringify(__serial) === "[10,20,30]");

  __r.done("p04-async", __fails);
})();
