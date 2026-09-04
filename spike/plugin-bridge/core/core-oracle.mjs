// M4 core-semantics oracle: plain node + real cordis, simulating the host
// bridge in pure JS. Pins the cordis behaviors the v0 bridge relies on before
// any AOT: provide-from-plugin-body, teardown unprovide, deferred inject
// across load/unload, and sync call routing.
// Output contract: PASS|FAIL per probe, RESULT lines, VERDICT, exit = fails.

import { Context } from "@deepseek-ai/cordis";

var log = console.log.bind(console);
var fails = 0;
var total = 0;

function check(name, ok, detail) {
  total++;
  if (ok) log("PASS " + name);
  else { fails++; log("FAIL " + name + " - " + detail); }
}

function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

// Simulated plugin instance (what the host bridge routes to)
function makeFakePluginModule() {
  const calls = [];
  let disposed = false;
  return {
    calls,
    isDisposed: () => disposed,
    pluginCall: (fn, a, b) => { calls.push([fn, a, b]); return fn === 0 ? a + b : -1; },
    pluginDispose: () => { disposed = true; return 0; },
  };
}

// ---------------------------------------------------------------------------
// o1: provide from INSIDE the plugin body is visible to outside inject
{
  const ctx = new Context();
  const mod = makeFakePluginModule();
  const seen = [];
  ctx.inject(["counter"], (c) => seen.push(c.counter.call(0, 20, 22)));
  check("o1-deferred-before-load", seen.length === 0, "fired early: " + seen.length);

  const fiber = ctx.plugin((local) => {
    local.effect(() => () => mod.pluginDispose());
    local.provide("counter", {
      call: (fn, a, b) => mod.pluginCall(fn, a, b),
    });
  });
  await Promise.resolve(fiber);
  await flush();
  check("o1-inject-after-load", seen.length === 1 && seen[0] === 42,
    "seen=" + JSON.stringify(seen));

  await fiber.dispose();
  await flush();
  check("o1-unload-disposes-plugin", mod.isDisposed(), "plugin not disposed");
}

// ---------------------------------------------------------------------------
// o2: after unload, inject defers again (service gone)
{
  const ctx = new Context();
  const mod = makeFakePluginModule();
  const fiber = ctx.plugin((local) => {
    local.provide("toy", { call: (fn, a, b) => mod.pluginCall(fn, a, b) });
  });
  await Promise.resolve(fiber);
  await flush();

  let gone = 0;
  const fiber2 = ctx.plugin((local2) => {
    local2.inject(["toy"], (c) => gone++);
  });
  await Promise.resolve(fiber2);
  await flush();
  check("o2-visible-before-unload", gone === 1, "gone=" + gone);

  await fiber.dispose();
  await flush();
  gone = 0;
  const fiber3 = ctx.plugin((local3) => {
    local3.inject(["toy"], (c) => gone++);
  });
  await Promise.resolve(fiber3);
  await flush();
  check("o2-miss-after-unload", gone === 0, "gone=" + gone);
}

// ---------------------------------------------------------------------------
// o3: sync call routing — the bridge call's result is available in the same
// synchronous block as the rest of the effect body (fiber START is a cordis
// microtask; the CALL itself must not add any async hop)
{
  const ctx = new Context();
  const mod = makeFakePluginModule();
  const trace = [];
  const fiber = ctx.plugin((local) => {
    local.effect(() => {
      trace.push("pre");
      const r = mod.pluginCall(0, 20, 22); // sync across "bridge"
      trace.push("post:" + r);             // same sync block, result in hand
      return () => trace.push("torn");
    });
  });
  await Promise.resolve(fiber);
  await flush();
  check("o3-call-sync-in-body", trace.join(",") === "pre,post:42",
    "trace=" + JSON.stringify(trace));
  await fiber.dispose();
  await flush();
  check("o3-teardown-order", trace.join(",").endsWith("torn"),
    "trace=" + JSON.stringify(trace));
}

// ---------------------------------------------------------------------------
// o4: isConstructor safety — the bridge wrapper must be an arrow function
{
  const ctx = new Context();
  const mod = makeFakePluginModule();
  const trace = [];
  function NamedWrapper(local) { // would be classified as class by cordis
    local.effect(() => () => trace.push("torn"));
  }
  const arrowWrapper = (local) => {
    local.effect(() => () => trace.push("torn"));
  };
  const f1 = ctx.plugin(NamedWrapper);
  const f2 = ctx.plugin(arrowWrapper);
  await Promise.resolve(f1);
  await Promise.resolve(f2);
  await f1.dispose();
  await f2.dispose();
  await flush();
  check("o4-effect-teardown-both", trace.join(",") === "torn,torn",
    "trace=" + JSON.stringify(trace));
}

log("RESULT: " + (total - fails) + "/" + total + " probes passed");
log("VERDICT: " + (fails ? "RED (" + fails + ")" : "GREEN"));
process.exitCode = fails;
