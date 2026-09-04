// p08 — error surface: Error subclassing, stack surgery, prototype markers, constructor walks.
// Grounded in cordis enhanceError (:678), handleError (:192), composeError, ValidationError (:946).
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

// Error subclass + instanceof + message (cordis CordisError)
class __CordisError extends Error {
  constructor(message, code) { super(message); this.code = code; this.name = "CordisError"; }
}
const __err = new __CordisError("bad thing", 1234);
__assert("subclass-instanceof", __err instanceof __CordisError && __err instanceof Error);
__assert("subclass-fields", __err.message === "bad thing" && __err.code === 1234 && __err.name === "CordisError");
__assert("subclass-throwable", (() => { try { throw new __CordisError("thrown", 1); } catch (e) { return e instanceof __CordisError && e.message === "thrown"; } })());

// stack string surgery (cordis enhanceError: split, splice, join)
var __stackOK = typeof __err.stack === "string" && __err.stack.split("\n").length > 0;
if (__stackOK) {
  const __before = __err.stack.split("\n").length;
  const __lines = __err.stack.split("\n");
  __lines.splice(0, 2, "Error: rewritten");
  __err.stack = __lines.join("\n");
  __assert("stack-surgery", __err.stack.startsWith("Error: rewritten") && __err.stack.includes("\n"));
  __assert("stack-string-type", typeof __err.stack === "string");
} else {
  __r.fail("stack-surgery", "Error.stack missing or not a string");
  __r.skip("stack-string-type", "no stack to test");
}

// splice with Infinity (cordis handleError uses lines.splice(1, Infinity, ...))
const __frames = ["a", "b", "c", "d"];
__frames.splice(1, Infinity, "X");
__assert("splice-infinity", JSON.stringify(__frames) === '["a","X"]');

// endsWith on frame strings (cordis checks ' (<anonymous>)' suffix)
__assert("frame-endswith", "at foo (<anonymous>)".endsWith(" (<anonymous>)") === true && "at foo".endsWith(" (<anonymous>)") === false);

// defineProperty marker on prototype (cordis ValidationError brand, :946)
const __kMarker = Symbol.for("p08.marker");
class __ValidationError extends Error {}
Object.defineProperty(__ValidationError.prototype, __kMarker, { value: true });
const __ve = new __ValidationError("v");
__assert("proto-marker", __ve[__kMarker] === true && __ValidationError.prototype[__kMarker] === true);

// constructor walk over prototype chains (cordis Service[Symbol.hasInstance] body, :1818)
function __walkHas(instance, target) {
  if (!instance) return false;
  let constructor = instance.constructor;
  while (constructor) {
    constructor = constructor.prototype?.constructor;
    if (constructor === target) return true;
    constructor &&= Object.getPrototypeOf(constructor);
  }
  return false;
}
class __P1 {}
class __P2 extends __P1 {}
__assert("ctor-walk", __walkHas(new __P2(), __P2) === true);
__assert("ctor-walk-miss", __walkHas(new __P2(), Error) === false);

// error message stringification + rethrow preserving type
function __wrapAndRethrow(fn) {
  try { fn(); } catch (e) { if (e instanceof __CordisError) throw e; throw new Error("wrapped: " + e.message); }
}
var __rethrown = null;
try { __wrapAndRethrow(() => { throw new __CordisError("keep-me", 7); }); } catch (e) { __rethrown = e; }
__assert("rethrow-type-preserved", __rethrown instanceof __CordisError && __rethrown.code === 7);

__r.done("p08-error-surface", __fails);
