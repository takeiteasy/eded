// M3 lifecycle harness: real @deepseek-ai/cordis 4.0.2 under shermes AOT.
// Output contract matches the M2 suite: PASS|FAIL name - detail, RESULT
// per probe, VERDICT: GREEN|RED at the end; exit code = failure count.
// Node runs this file directly as the oracle; bundle.sh wraps the same
// file into an IIFE for the AOT pipeline.

var log = typeof print === "function" ? print : console.log.bind(console);

var __suite = { fails: 0, pending: 6 };
globalThis.__report = {
  pass: (n) => log("PASS " + n),
  fail: (n, d) => { __suite.fails++; log("FAIL " + n + " - " + d); },
  done: (n, f) => {
    __suite.fails += f;
    __suite.pending--;
    log("RESULT " + n + ": " + f + " failed");
    if (__suite.pending === 0) {
      log("VERDICT: " + (__suite.fails ? "RED (" + __suite.fails + " failures)" : "GREEN"));
      if (typeof quit === "function") quit(__suite.fails);
      if (typeof process !== "undefined") process.exitCode = __suite.fails;
    }
  },
};

function eq(actual, expected) {
  return actual === expected;
}

import { Context, Service } from "@deepseek-ai/cordis";

// ---------------------------------------------------------------------------
// p1 provide / inject across contexts
(function () {
  const name = "p1-provide-inject";
  try {
    const ctx = new Context();
    const seen = [];
    ctx.provide("math", { double: (x) => x * 2 });
    const child = ctx.extend();
    ctx.inject(["math"], (c) => { seen.push(c.math.double(21)); });
    // inject-miss: a plugin with an unmet dep must not run until provided
    const deferred = [];
    ctx.inject(["missing"], (c) => { deferred.push(c.missing); });
    const firedBefore = deferred.length;
    ctx.provide("missing", 42);
    return Promise.resolve().then(() => {
      const ok = eq(seen.join(","), "42") && eq(firedBefore, 0) && eq(deferred.length, 1) && eq(deferred[0], 42);
      globalThis.__report[ok ? "pass" : "fail"](name,
        ok ? "" : `seen=${JSON.stringify(seen)} deferred=${JSON.stringify(deferred)} before=${firedBefore}`);
      globalThis.__report.done(name, ok ? 0 : 1);
    });
  } catch (e) {
    globalThis.__report.fail(name, String(e && e.stack || e));
    globalThis.__report.done(name, 1);
  }
})();

// ---------------------------------------------------------------------------
// p2 real Service subclass registration
(function () {
  const name = "p2-service-class";
  try {
    const ctx = new Context();
    class Counter extends Service {
      static provide = "counter";
      constructor(ctx) {
        super(ctx, Counter.provide);
        this.n = 0;
      }
      inc() { return ++this.n; }
    }
    new Counter(ctx);
    const direct = ctx.counter;
    const viaInject = [];
    ctx.inject(["counter"], (c) => viaInject.push(c.counter.inc()));
    return Promise.resolve().then(() => {
      const ok = direct instanceof Counter && viaInject.length === 1 && viaInject[0] === 1
        && eq(ctx.counter.inc(), 2);
      globalThis.__report[ok ? "pass" : "fail"](name,
        ok ? "" : `direct=${typeof direct} viaInject=${JSON.stringify(viaInject)}`);
      globalThis.__report.done(name, ok ? 0 : 1);
    });
  } catch (e) {
    globalThis.__report.fail(name, String(e && e.stack || e));
    globalThis.__report.done(name, 1);
  }
})();

// ---------------------------------------------------------------------------
// p3 effect: sync body, disposer on plugin unload
(function () {
  const name = "p3-effect-sync";
  try {
    const ctx = new Context();
    const trace = [];
    const fiber = ctx.plugin((local) => {
      local.effect(() => () => trace.push("torn"));
      trace.push("body");
    });
    return Promise.resolve(fiber).then(() => fiber.dispose()).then(() => {
      const ok = eq(trace.join(","), "body,torn");
      globalThis.__report[ok ? "pass" : "fail"](name, ok ? "" : `trace=${JSON.stringify(trace)}`);
      globalThis.__report.done(name, ok ? 0 : 1);
    }, (e) => {
      globalThis.__report.fail(name, String(e && e.stack || e));
      globalThis.__report.done(name, 1);
    });
  } catch (e) {
    globalThis.__report.fail(name, String(e && e.stack || e));
    globalThis.__report.done(name, 1);
  }
})();

// ---------------------------------------------------------------------------
// p4 effect: async body + async disposer, ordered teardown
(function () {
  const name = "p4-effect-async";
  try {
    const ctx = new Context();
    const trace = [];
    const tick = () => new Promise((r) => { trace.push("tick"); r(); });
    const fiber = ctx.plugin((local) => {
      local.effect(async () => {
        trace.push("a-body");
        await tick();
        return async () => { trace.push("a-torn"); await tick(); };
      });
      local.effect(() => () => trace.push("b-torn"));
    });
    return Promise.resolve(fiber).then(() => fiber.dispose()).then(() => {
      const ok = eq(trace.join(","), "a-body,tick,b-torn,a-torn,tick");
      globalThis.__report[ok ? "pass" : "fail"](name, ok ? "" : `trace=${JSON.stringify(trace)}`);
      globalThis.__report.done(name, ok ? 0 : 1);
    }, (e) => {
      globalThis.__report.fail(name, String(e && e.stack || e));
      globalThis.__report.done(name, 1);
    });
  } catch (e) {
    globalThis.__report.fail(name, String(e && e.stack || e));
    globalThis.__report.done(name, 1);
  }
})();

// ---------------------------------------------------------------------------
// p5 plugin with inject deps: start, provide, unload (dispose)
(function () {
  const name = "p5-plugin-lifecycle";
  try {
    const ctx = new Context();
    const trace = [];
    const plugin = (local) => {
      trace.push("start:" + local.host.value);
      return async () => { trace.push("stop"); };
    };
    plugin.inject = ["host"];
    const fiber = ctx.plugin(plugin);
    let fired = false;
    Promise.resolve(fiber).then(() => { fired = true; });
    const ok1 = eq(trace.length, 0); // must not start before dep exists
    ctx.provide("host", { value: "up" });
    return Promise.resolve(fiber).then(() => {
      const started = eq(trace.join(","), "start:up");
      return fiber.dispose().then(() => {
        const ok = ok1 && started && fired && eq(trace.join(","), "start:up,stop");
        globalThis.__report[ok ? "pass" : "fail"](name, ok ? "" : `trace=${JSON.stringify(trace)} fired=${fired}`);
        globalThis.__report.done(name, ok ? 0 : 1);
      });
    }, (e) => {
      globalThis.__report.fail(name, String(e && e.stack || e));
      globalThis.__report.done(name, 1);
    });
  } catch (e) {
    globalThis.__report.fail(name, String(e && e.stack || e));
    globalThis.__report.done(name, 1);
  }
})();

// ---------------------------------------------------------------------------
// p6 isConstructor pitfall: named function with .prototype drops returned
// disposer (cordis runs `new plugin()`); ctx.effect teardown still runs.
(function () {
  const name = "p6-isconstructor-pitfall";
  try {
    const ctx = new Context();
    const trace = [];
    function Pitfall(local) {
      local.effect(() => () => trace.push("effect-torn"));
      return () => trace.push("dropped-disposer");
    }
    const fiber = ctx.plugin(Pitfall);
    return Promise.resolve(fiber).then(() => fiber.dispose()).then(() => {
      const ok = eq(trace.join(","), "effect-torn") && !trace.includes("dropped-disposer");
      globalThis.__report[ok ? "pass" : "fail"](name, ok ? "" : `trace=${JSON.stringify(trace)}`);
      globalThis.__report.done(name, ok ? 0 : 1);
    }, (e) => {
      globalThis.__report.fail(name, String(e && e.stack || e));
      globalThis.__report.done(name, 1);
    });
  } catch (e) {
    globalThis.__report.fail(name, String(e && e.stack || e));
    globalThis.__report.done(name, 1);
  }
})();
