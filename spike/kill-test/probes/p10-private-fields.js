// p10 — private fields/methods/statics (known-risk set; cordis itself uses none, plugins may).
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

class __Vault {
  #secret = "hidden";
  #audit = [];
  static #master = "root";
  #reveal() { return this.#secret; }
  static #masterKey() { return __Vault.#master; }
  open() { return this.#reveal(); }
  addAudit(entry) { this.#audit.push(entry); return this.#audit.length; }
  getAudit() { return [...this.#audit]; }
  static master() { return __Vault.#masterKey(); }
  hasSecret(obj) { return #secret in obj; }
}
const __v = new __Vault();
__assert("private-field", __v.open() === "hidden");
__assert("private-method", __v.addAudit("a1") === 1 && __v.addAudit("a2") === 2 && JSON.stringify(__v.getAudit()) === '["a1","a2"]');
__assert("private-static", __Vault.master() === "root");
__assert("private-in", __v.hasSecret(__v) === true && __v.hasSecret({}) === false);
__assert("private-encapsulated", Object.getOwnPropertyNames(__v).indexOf("secret") === -1 && Object.getOwnPropertyNames(__v).indexOf("audit") === -1);

// private fields through subclass with super field init
class __Safe extends __Vault {
  #pin = 1234;
  check(pin) { return pin === this.#pin && this.open() === "hidden"; }
}
__assert("private-subclass", new __Safe().check(1234) === true);

// brand collision: two classes with same-named private field reject foreign instances
class __Other { #secret = "other"; peek(o) { try { return o.#secret; } catch (e) { return "TypeError"; } } }
__assert("private-brand-check", new __Other().peek(__v) === "TypeError");

__r.done("p10-private-fields", __fails);
