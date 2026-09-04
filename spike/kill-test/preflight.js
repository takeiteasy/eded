// M2 pre-flight: native shermes microtask/generator drain semantics.
var __log = typeof print === "function" ? print : console.log.bind(console);
__log("preflight: start");
(async () => {
  await Promise.resolve();
  __log("preflight: microtask ran");
  await Promise.all([Promise.resolve(1), Promise.resolve(2)]);
  __log("preflight: Promise.all ran");
})().then(() => __log("preflight: then ran"));
function* gen() { yield 1; yield 2; }
const vals = [];
for (const v of gen()) vals.push(v);
__log("preflight: gen " + vals.join(","));
__log("PREFLIGHT OK");
