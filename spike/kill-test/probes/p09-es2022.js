// p09 — es2022 surface cordis's bundle relies on: optional chaining, nullish, spread/rest,
// computed symbol keys, Object.hasOwn, parseInt quirks, template literals, string methods.
// Grounded in cordis isSpecialProperty (:668), _resolveConfig (:608), utils.
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

// optional chaining + nullish (cordis: constructor.prototype?.constructor, name ??= config.name)
const __deep = { a: { b: { c: "deep" } } };
__assert("optchain-hit", __deep.a?.b?.c === "deep");
__assert("optchain-miss", __deep.x?.y?.z === undefined);
__assert("optchain-call", (void 0)?.() === undefined && ({ f: () => 7 })?.f?.() === 7);
var __nullish1 = null ?? "fallback";
var __nullish2 = 0 ?? "nope";
__assert("nullish-coalesce", __nullish1 === "fallback" && __nullish2 === 0);
function __cfg(opts) { opts ??= {}; opts.name ??= "default"; return opts.name; }
__assert("nullish-assign", __cfg() === "default" && __cfg({ name: "custom" }) === "custom");

// spread / rest / destructuring (cordis: Object.assign({}, ...configs), [...this.map.values()])
const __part = { a: 1, b: 2 };
const __merged = Object.assign({}, ...[{ a: 9 }, { b: 22, c: 3 }]);
__assert("assign-merge", __merged.a === 9 && __merged.b === 22 && __merged.c === 3);
const __arr = [...[1, 2], ...[3]];
__assert("array-spread", JSON.stringify(__arr) === "[1,2,3]");
function __rest(first, ...tail) { return first + ":" + tail.join(","); }
__assert("rest-params", __rest(1, 2, 3) === "1:2,3");
const { a: __ra, ...__restObj } = { a: 1, b: 2, c: 3 };
__assert("obj-rest-destructure", __ra === 1 && JSON.stringify(__restObj) === '{"b":2,"c":3}');
const [__first, ...__tailArr] = [10, 20, 30];
__assert("array-rest-destructure", __first === 10 && JSON.stringify(__tailArr) === "[20,30]");
__assert("default-destructure", (() => { const { x = 5, y = 6 } = { x: 1 }; return x === 1 && y === 6; })());

// computed symbol keys (cordis symbols registry + computed method names)
const __sk = Symbol.for("p09.key");
const __obj = { __sk: "wrong", [__sk]: "right" };
__assert("computed-symbol-key", __obj[__sk] === "right" && __obj.__sk === "wrong");
const __obj2 = { [Symbol.for("p09.m")]() { return "sym-method"; } };
__assert("computed-symbol-method", __obj2[Symbol.for("p09.m")]() === "sym-method");

// Object.hasOwn + static props (cordis uses Object.hasOwn in _resolveConfig)
__assert("hasown", Object.hasOwn({ p: 1 }, "p") === true && Object.hasOwn(Object.create({ p: 1 }), "p") === false);
__assert("object-create-null", (() => { const o = Object.create(null); o.k = 1; return "k" in o && o.toString === undefined; })());

// parseInt quirk (cordis isSpecialProperty: parseInt(prop).toString() === prop)
__assert("parseint-quirk", parseInt("007").toString() === "7" && parseInt("0x1f").toString() === "31" && parseInt("1.5").toString() === "1" && parseInt("abc").toString() === "NaN");
__assert("special-property-shape", (() => {
  const isSpecial = (prop) => typeof prop === "symbol" || ["prototype", "then"].includes(prop) || parseInt(prop).toString() === prop || prop.startsWith("_");
  return isSpecial("prototype") && isSpecial("7") && !isSpecial("007") && !isSpecial("0x1f") && isSpecial("_private") && !isSpecial("logger");
})());

// template literals + tagged templates
const __who = "eded";
__assert("template-literal", `hello ${__who}, ${1 + 1}` === "hello eded, 2");
__assert("multiline-template", `a\nb`.length === 3);

// string methods cordis uses (hyphenate output handling, stack frames)
__assert("string-methods", "FooBar".startsWith("Foo") && "x.js:1".endsWith(":1") && "a-b-c".split("-").join() === "a,b,c" && "  pad  ".trim() === "pad");
__assert("string-includes", "Cannot get property".includes("property") === true);

// typeof shapes used by isObject/isNullable-style checks
__assert("typeof-shapes", typeof undefined === "undefined" && typeof null === "object" && typeof (() => {}) === "function" && typeof Symbol() === "symbol");

// JSON round trip of plain config objects (cordis configs flow through these)
__assert("json-roundtrip", JSON.parse(JSON.stringify({ a: [1, { b: null }] })).a[1].b === null);

__r.done("p09-es2022", __fails);
