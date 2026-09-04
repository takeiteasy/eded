// p11 — MINI CORDIS-SHAPED CONTEXT: the load-bearing Proxy stress.
// Mirrors cordis mechanisms: shared proxy handler (get/set/has, ReflectService.handler :671),
// extend() via Object.create(proxy) (:1694), isolate() label chains (:1709), services via
// WeakMap-keyed store, DisposableList (Map+WeakMap, :4), effects with sync/async disposers
// (:1155+), start() = Promise.all, dispose() = reversed clear + parallel awaited disposers.
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
const __isThenable = (v) => v && typeof v.then === "function";

(async () => {
  const __sym = {
    isolate: Symbol.for("mctx.isolate"),
    is: Symbol.for("mctx.is")
  };
  const __RESERVED = ["prototype", "then"];
  const __isSpecial = (prop) =>
    typeof prop === "symbol" || __RESERVED.includes(prop) ||
    parseInt(prop).toString() === prop || prop.startsWith("_");

  const __store = new WeakMap(); // label -> service impl (cordis keys fibers by label)
  const __provided = [];         // { name, label, ctx } for disposal
  const __providedNames = new Set(); // registry for the has trap (cordis: reflect.props)

  class __Context {
    constructor() {
      this[__sym.isolate] = Object.create(null);
      this.tag = "root";
      const self = new Proxy(this, __handler);
      self[__sym.is] = true;
      return self; // constructor returns proxy (cordis Context ctor, :1680)
    }
    extend(meta = {}) {
      const self = Object.create(this);
      for (const prop of Reflect.ownKeys(meta))
        Object.defineProperty(self, prop, Object.getOwnPropertyDescriptor(meta, prop));
      return self;
    }
    isolate(name, label) {
      const shadow = Object.create(this[__sym.isolate]);
      shadow[name] = label ?? Symbol(name);
      return this.extend({ [__sym.isolate]: shadow });
    }
    provide(name, impl) {
      const iso = this[__sym.isolate];
      const label = iso[name] ?? (iso[name] = Symbol(name));
      __store.set(label, impl);
      __provided.push({ name, label, ctx: this });
      __providedNames.add(name);
      return () => { __store.delete(label); return true; };
    }
    effect(execute, label = "anonymous") {
      const result = execute();
      const entry = { label, result, task: __isThenable(result) ? result : Promise.resolve() };
      const sn = __effects.push(entry);
      return () => __effects.deleteBySn(sn);
    }
    async start() {
      await Promise.all([...__effects.list()].map((e) => e.task));
      return true;
    }
    async dispose() {
      const entries = __effects.clear(); // reversed (DisposableList.clear, cordis :22)
      const results = await Promise.allSettled(entries.map(async (e) => {
        const d = await e.result;          // sync or async effect body
        if (typeof d === "function") await d(); // disposer may be async too
      }));
      for (const p of __provided) __store.delete(p.label); // unload services
      return results.every((r) => r.status === "fulfilled");
    }
  }

  // DisposableList: Map (order) + WeakMap (reverse lookup), clear() reverses (cordis :4)
  class __Effects {
    sn = 0;
    map = new Map();
    weak = new WeakMap();
    push(entry) {
      const sn = ++this.sn;
      this.map.set(sn, entry);
      this.weak.set(entry, sn);
      return sn;
    }
    deleteBySn(sn) { return this.map.delete(sn); }
    delete(entry) {
      const sn = this.weak.get(entry);
      if (!sn) return false;
      return this.map.delete(sn);
    }
    list() { return [...this.map.values()]; }
    clear() { const v = [...this.map.values()]; this.map.clear(); return v.reverse(); }
  }
  const __effects = new __Effects();

  // Shared handler — one handler object for every context proxy (cordis ReflectService.handler)
  const __handler = {
    get: (target, prop, ctx) => {
      if (__isSpecial(prop)) return Reflect.get(target, prop, ctx);
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, ctx);
      // service resolution: the isolate chain must come from the RECEIVER (child contexts
      // carry their own isolate shadow); `target` is always the root's backing object
      const label = ctx[__sym.isolate][prop];
      if (label && __store.has(label)) return __store.get(label);
      throw new Error(`cannot get property "${String(prop)}" without inject`);
    },
    set: (target, prop, value, ctx) => {
      if (__isSpecial(prop)) return Reflect.set(target, prop, value, ctx);
      return Reflect.set(target, prop, value, ctx);
    },
    has: (target, prop) => {
      // cordis's has trap is registry-based too (ReflectService.handler.has -> target.reflect.props)
      if (Reflect.has(target, prop)) return true;
      return __providedNames.has(prop);
    }
  };

  // ---- lifecycle test ----
  const __order = [];
  const __root = new __Context();

  // brand + then-safety: a context proxy must not look like a thenable
  __assert("ctx-then-safe", __root.then === undefined && __root[Symbol.toPrimitive] === undefined);

  // provide + inject through the proxy
  __root.provide("math", { double: (n) => n * 2, name: "math-v1" });
  __assert("inject-root", __root.math.double(21) === 42);
  __assert("has-service", "math" in __root && "nope" in __root === false);

  // extend(): child inherits prototypally through the proxy
  const __child = __root.extend({ tag: "child" });
  __assert("child-own-shadow", __child.tag === "child");
  __assert("child-inject-through-proxy", __child.math.double(5) === 10);
  __assert("child-is-brand", __child[__sym.is] === true && __root[__sym.is] === true);

  // grandchild: two hops
  const __grand = __child.extend({ tag: "grand" });
  __assert("grandchild-inject", __grand.math.name === "math-v1");

  // inject failure throws the cordis-shaped error
  var __injectErr = null;
  try { __root.nothing; } catch (e) { __injectErr = e; }
  __assert("inject-throws", __injectErr instanceof Error && /without inject/.test(__injectErr.message), String(__injectErr));

  // effects: sync + async bodies with sync + async disposers
  const __e1 = __root.effect(() => {
    __order.push("e1-start");
    return () => { __order.push("e1-dispose"); };
  }, "e1");
  const __e2 = __root.effect(async () => {
    __order.push("e2-start");
    await Promise.resolve();
    __order.push("e2-ready");
    return async () => { __order.push("e2-dispose"); };
  }, "e2");
  const __e3 = __root.effect(() => {
    __order.push("e3-start");
    return () => { __order.push("e3-dispose"); };
  }, "e3");
  __assert("effects-registered", typeof __e1 === "function" && typeof __e2 === "function");

  // unregister e3 before start (cordis disposers are values with O(1) delete)
  __e3();
  const __orderAtStart = [...__order];
  await __root.start();
  __assert("start-awaits-effects", __orderAtStart.indexOf("e1-start") !== -1 && __order.indexOf("e2-ready") !== -1, __order.join());
  __assert("sync-effect-ran-before-start", __order.indexOf("e1-start") <= __order.indexOf("e2-start"));

  // isolate: child scope gets its own implementation, parent unaffected
  const __iso = __root.isolate("math");
  __iso.provide("math", { double: (n) => n * 10, name: "math-v2" });
  __assert("isolate-child-impl", __iso.math.double(3) === 30 && __iso.math.name === "math-v2");
  __assert("isolate-parent-unaffected", __root.math.name === "math-v1" && __child.math.name === "math-v1");

  // set through the proxy: own prop on target, visible through chain
  __root.version = 1;
  __assert("set-through-ctx", __root.version === 1 && __child.version === 1);
  __child.version = 2;
  __assert("child-set-shadows", __child.version === 2 && __root.version === 1);

  // dispose: services unloaded, disposers invoked LIFO (clear() reverses)
  const __disposedOK = await __root.dispose();
  __assert("dispose-fulfilled", __disposedOK === true);
  __assert("dispose-lifo", (() => {
    const idx = (s) => __order.indexOf(s);
    return idx("e2-dispose") !== -1 && idx("e2-dispose") < idx("e1-dispose");
  })(), __order.join());
  var __goneErr = null;
  try { __root.math; } catch (e) { __goneErr = e; }
  __assert("service-unloaded-after-dispose", __goneErr instanceof Error && /without inject/.test(__goneErr.message));

  __r.done("p11-mini-context", __fails);
})();
