// p06 — class features: bare instance fields, static fields, static blocks, getters,
// constructor returning object, static Symbol.hasInstance (cordis Context/Service shapes).
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

const __symInit = Symbol.for("p06.init");
const __symBrand = Symbol.for("p06.brand");
const __initLog = [];

// Service-like class: bare fields, static fields, static block writing symbol props (cordis Service :1740, Context :1672)
var __Service = class __Svc {
  ctx;
  name;
  sn = 0;
  static init = __symInit;
  static check = Symbol.for("p06.check");
  get label() { return this._label ?? this.name; }
  set label(v) { this._label = v; }
  constructor(ctx, name) {
    this.ctx = ctx;
    this.name = name;
    if (typeof __initLog !== "undefined") __initLog.push(name);
  }
  static {
    __Svc.prototype[__symInit] = function () { return "init:" + this.name; };
    __Svc.prototype[__symBrand] = true;
  }
  [Symbol.iterator]() { return [1, 2].values(); }
};
__assert("bare-fields", (() => { const s = new __Service(null, "alpha"); return s.ctx === null && s.name === "alpha" && s.sn === 0 && !("ctx" in Object.prototype); })());
__assert("static-fields", __Service.init === __symInit && typeof __Service.check === "symbol");
__assert("static-block-proto-symbol", new __Service(null, "beta")[__symInit]() === "init:beta");
__assert("static-block-brand", new __Service(null, "g")[__symBrand] === true);
__assert("ctor-init-log", __initLog.join() === "alpha,beta,g");
__assert("instanceof", new __Service(null, "x") instanceof __Service);
__assert("class-getter-setter", (() => { const s = new __Service(null, "n"); s.label = "L"; return s.label === "L" && new __Service(null, "m").label === "m"; })());
__assert("symbol-iterator-method", JSON.stringify([...new __Service(null, "it")]) === "[1,2]");

// constructor returning an object replaces `this` (cordis Context ctor returns proxy, Service returns callable)
const __replacement = { replaced: true };
class __ReturnsOther {
  constructor() { this.ignored = true; return __replacement; }
}
__assert("ctor-returns-object", new __ReturnsOther() === __replacement);
class __ReturnsPrimitive { constructor() { return 42; } }
__assert("ctor-returns-primitive-ignored", new __ReturnsPrimitive() instanceof __ReturnsPrimitive);

// static Symbol.hasInstance with prototype-chain walk (cordis Service :1814)
class __Base {}
class __Mid extends __Base {}
class __Leaf extends __Mid {}
Object.defineProperty(__Base, Symbol.hasInstance, {
  value: (instance) => {
    if (!instance) return false;
    let constructor = instance.constructor;
    while (constructor) {
      constructor = constructor.prototype?.constructor;
      if (constructor === __Base) return true;
      constructor &&= Object.getPrototypeOf(constructor);
    }
    return false;
  }
});
__assert("hasinstance-walk", new __Leaf() instanceof __Base === true && __Leaf instanceof __Base === false, "walk matches instances; the class itself has .constructor = Function so it misses (matches cordis: only plugin instances are classified)");
__assert("hasinstance-false", {} instanceof __Base === false && null instanceof __Base === false);

// extends + super + super.method
class __Animal {
  constructor(name) { this.name = name; }
  speak() { return this.name + " makes a sound"; }
}
class __Dog extends __Animal {
  constructor(name) { super(name); this.kind = "dog"; }
  speak() { return super.speak() + " (barks)"; }
}
__assert("extends-super", new __Dog("Rex").speak() === "Rex makes a sound (barks)");

// class expression named binding is inner-only
const __Outer = class __InnerName {};
__assert("class-expression-name", __Outer.name === "__InnerName");

// Object.create(proto) with class instances + property forwarding
const __delegated = Object.create(new __Animal("generic"));
__assert("create-from-instance", __delegated.name === "generic" && __delegated instanceof __Animal);

__r.done("p06-classes", __fails);
