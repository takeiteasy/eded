// p01 — Proxy traps: shared handler, get/set/has, receiver plumbing, throwing traps.
// Grounded in cordis ReflectService.handler + withProps (lib/index.js:671, :94).
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

var __special = Symbol.for("p01.special");
var __handlerHits = [];
// Shared handler object like cordis's ReflectService.handler (one handler, many proxies).
var __handler = {
  get: (target, prop, ctx) => {
    if (prop === __special) return "special";
    if (typeof prop === "symbol") return Reflect.get(target, prop, ctx);
    __handlerHits.push("get:" + String(prop));
    if (Reflect.has(target, prop)) return Reflect.get(target, prop, ctx);
    throw new Error('cannot get property "' + String(prop) + '" without inject');
  },
  set: (target, prop, value, ctx) => {
    if (prop === __special) return false;
    return Reflect.set(target, prop, value, ctx);
  },
  has: (target, prop) => {
    __handlerHits.push("has:" + String(prop));
    if (Reflect.has(target, prop)) return true;
    return String(prop).startsWith("svc.");
  }
};

var __target = { plain: 1, fn: function () { return typeof this === "object" ? "receiver-ok" : "receiver-bad"; } };
var __proxy = new Proxy(__target, __handler);

// get: own prop, symbol prop, missing prop throws
__assert("get-own", __proxy.plain === 1);
__assert("get-symbol", __proxy[__special] === "special");
var __threw = null;
try { __proxy.missing; } catch (e) { __threw = e; }
__assert("get-missing-throws", __threw instanceof Error && /without inject/.test(__threw.message), String(__threw));

// receiver plumbing: method extracted via proxy, `this` must be the proxy
__assert("receiver-is-proxy", __proxy.fn() === "receiver-ok");

// set: through Reflect.set with proxy receiver; own prop created on target
__proxy.plain = 2;
__assert("set-through", __target.plain === 2 && __proxy.plain === 2);
__proxy.added = "new";
__assert("set-new-prop", "added" in __target);

// set rejecting special prop
var __setBlocked = false;
try { __proxy[__special] = 1; } catch (e) { __setBlocked = false; } // strict-mode set via assignment would throw on false return? assignment in non-strict ignores
__setBlocked = __proxy[__special] !== 1;
__assert("set-blocked", __setBlocked, "set trap returned false but value written");

// has trap: consulted, falls back to synthetic answers
__assert("has-own", "plain" in __proxy);
__assert("has-synthetic", "svc.logger" in __proxy && "nothing-here" in __proxy === false);

// handler reuse: many proxies, one handler (cordis pattern)
var __t2 = { plain: 99 };
var __p2 = new Proxy(__t2, __handler);
__assert("shared-handler", __p2.plain === 99 && __proxy.plain === 2);

// trap order recorded
__assert("trap-log", __handlerHits.indexOf("get:plain") !== -1 && __handlerHits.indexOf("has:svc.logger") !== -1);

// Reflect interop through the proxy (cordis getTraceable pattern)
__assert("reflect-has-through-proxy", Reflect.has(__proxy, "plain") === true);
__assert("reflect-get-receiver", Reflect.get(__target, "fn", __proxy)() === "receiver-ok");
__assert("getownpropertydesc-proxy", typeof Object.getOwnPropertyDescriptor(__proxy, "plain") === "object");
__assert("ownkeys-proxy", Reflect.ownKeys(__proxy).indexOf("plain") !== -1);

__r.done("p01-proxy-traps", __fails);
