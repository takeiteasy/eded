// p03 — Callable objects & apply-trap proxies: createCallable + createShadowMethod + isConstructor.
// Grounded in cordis lib/index.js:118 (apply trap), :164 (createCallable), :57 (isConstructor).
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

// createCallable: plain function with swapped prototype + defined name (cordis :164)
function __createCallable(name, proto) {
  var self = function (...args) { return ["called", self.tag, ...args]; };
  Object.defineProperty(self, "name", { value: name });
  Object.setPrototypeOf(self, proto);
  return self;
}
var __proto = Object.create(Function.prototype, {
  method: { value: function () { return "from-proto:" + this.tag; } },
  computed: { get: function () { return "getter-ok"; } }
});
var __callable = __createCallable("myService", __proto);
__callable.tag = "t1";
__assert("callable-name", __callable.name === "myService");
__assert("callable-call", JSON.stringify(__callable(1)) === '["called","t1",1]');
__assert("callable-proto-method", __callable.method() === "from-proto:t1");
__assert("callable-proto-getter", __callable.computed === "getter-ok");
__assert("callable-setproto", Object.getPrototypeOf(__callable) === __proto && typeof __callable === "function");

// apply-trap proxy over the callable (createShadowMethod shape, cordis :118)
var __applyLog = [];
var __shadow = new Proxy(__callable, {
  apply: (target, thisArg, args) => {
    __applyLog.push(args.length);
    return Reflect.apply(target, thisArg, args);
  }
});
__assert("apply-trap", __shadow(9)[2] === 9 && __applyLog.length === 1);
__assert("apply-prop-access-unaffected", __shadow.name === "myService" && __shadow.tag === "t1");
__assert("apply-proto-visible", __shadow.tag === "t1" && __shadow.method() === "from-proto:t1");

// isConstructor heuristic (cordis :57): .prototype presence + generator exclusion
function __isConstructor(func) {
  if (!func.prototype) return false;
  return true;
}
class __Klass {}
function __plainFn() {}
var __arrow = () => {};
function* __genfn() { yield 1; }
__assert("isctor-class", __isConstructor(__Klass) === true);
__assert("isctor-fn", __isConstructor(__plainFn) === true);
__assert("isctor-arrow", __isConstructor(__arrow) === false);
__assert("isctor-gen", __isConstructor(__genfn) === true, "generator fns DO have .prototype — cordis excludes them via instanceof GeneratorFunction (genfn-identity)");

// GeneratorFunction identity check (cordis :54-55 does .constructor === GeneratorFunction)
var __GeneratorFunction = function* () {}.constructor;
var __AsyncGeneratorFunction = null; // async gens rejected by shermes (compile-level); see p05
__assert("genfn-identity", __genfn instanceof __GeneratorFunction);
__assert("plainfn-not-gen", !(__plainFn instanceof __GeneratorFunction));
__assert("ctor-fn-name", __GeneratorFunction.name === "GeneratorFunction");

// .prototype visibility through a get-trap proxy (cordis checks func.prototype via ctx chains)
var __fnProxy = new Proxy(__plainFn, { get: (t, p, r) => Reflect.get(t, p, r) });
__assert("fn-proto-through-proxy", __fnProxy.prototype instanceof Object && __isConstructor(__fnProxy) === true);
var __arrowProxy = new Proxy(__arrow, { get: (t, p, r) => Reflect.get(t, p, r) });
__assert("arrow-proto-through-proxy", __isConstructor(__arrowProxy) === false);

// Function.prototype methods on callable with swapped proto
__assert("callable-bind-length", __callable.bind(null).length === 0 && __callable.length === 0);
__assert("callable-apply", __callable.apply(null, [7])[2] === 7);

__r.done("p03-callable-objects", __fails);
