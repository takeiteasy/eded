// Loop-scoping semantics probe for the static_h toolchain.
// static_h compiles legacy ES5 scoping unless -Xes6-block-scoping is passed;
// closures capturing loop-scoped let/const then share ONE binding (last value
// wins). eded's compile.sh bakes the flag in; run this probe after any
// hermes re-pin or toolchain change, native AND wasm:
//   shermes -exec -Xenable-tdz -Xes6-block-scoping probe-loop-scoping.js
// Exit code = failure count. See FINDINGS.md M3.
const fns = [];
for (let i = 0; i < 3; i++) { fns.push(() => i); }
const spec = fns[0]() === 0 && fns[1]() === 1 && fns[2]() === 2;
print(spec ? "PASS loop-scoping (0 1 2)" : "FAIL loop-scoping — got " +
  fns[0]() + " " + fns[1]() + " " + fns[2]() +
  " (shared binding: -Xes6-block-scoping missing?)");
if (!spec) {
  print("(native shermes has no quit(); rely on the FAIL line above)");
  if (typeof quit === "function") quit(1);
  if (typeof process !== "undefined") process.exitCode = 1;
} else if (typeof quit === "function") {
  quit(0);
}
