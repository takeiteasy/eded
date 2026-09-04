// p02 — Proxy in the prototype chain: cordis extend() does Object.create(proxy).
// Grounded in cordis Context.extend (lib/index.js:1694) and createShadow.
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

var __gets = [];
var __base = { baseProp: "base", who() { return "base"; } };
var __proxy = new Proxy(__base, {
  get: (target, prop, receiver) => {
    if (prop === "derived") return "derived-via-trap";
    __gets.push(String(prop));
    return Reflect.get(target, prop, receiver);
  },
  has: (target, prop) => Reflect.has(target, prop) || prop === "synthetic"
});

// Child inherits prototypally FROM the proxy — property reads must fall
// through the proxy traps (cordis extend() shape).
var __child = Object.create(__proxy);
__assert("child-own-first", (() => { Object.defineProperty(__child, "shadowed", { value: "own" }); return __child.shadowed === "own"; })());
__assert("child-through-proxy", __child.baseProp === "base");
__assert("child-trap-fallthrough", __child.derived === "derived-via-trap");
__assert("child-method-this", __child.who() === "base");

// `in` through the proxy prototype chain, has trap consulted
__assert("child-in-own", "shadowed" in __child);
__assert("child-in-proxied", "baseProp" in __child);
__assert("child-in-synthetic", "synthetic" in __child);

// getPrototypeOf sees the real chain; proxy is transparent
__assert("child-proto-is-proxy", Object.getPrototypeOf(__child) === __proxy);
// getPrototypeOf forwards through the proxy to the target's prototype
__assert("proxy-proto-is-base", Object.getPrototypeOf(__proxy) === Object.prototype);

// Grandchild: two hops through the proxy (cordis context chains)
var __grand = Object.create(Object.create(__proxy));
__assert("grandchild-through-chain", __grand.baseProp === "base" && __grand.derived === "derived-via-trap");
__assert("grandchild-shadow-skips", Object.create(__child).shadowed === "own");

// defineProperty on child shadows the trap without touching the target
Object.defineProperty(__child, "baseProp", { value: "shadow", writable: true });
__assert("child-shadows-trap", __child.baseProp === "shadow" && __base.baseProp === "base");

// Symbols through the chain
var __sym = Symbol.for("p02.sym");
__base[__sym] = "symval";
__assert("symbol-through-chain", __child[__sym] === "symval");

// extend-style: defineProperty with descriptors from a meta object (cordis extend body)
function __extend(parent, meta) {
  var self = Object.create(parent);
  for (var k of Reflect.ownKeys(meta)) Object.defineProperty(self, k, Object.getOwnPropertyDescriptor(meta, k));
  return self;
}
var __meta = {};
__meta[Symbol.for("p02.meta")] = "msym";
var __c2 = __extend(__proxy, __meta);
__assert("extend-descriptors", __c2.baseProp === "shadow" ? false : __c2[Symbol.for("p02.meta")] === "msym" && __c2.baseProp === "base");

__r.done("p02-proxy-prototype", __fails);
