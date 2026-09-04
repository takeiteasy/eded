// M1 toolchain smoke test — proves the JS -> wasm pipe, not the kill-test.
// Deliberately trivial; Proxy/WeakRef/async probes belong to M2.
const greet = (name) => `hello from eded, ${name}`;

class Core {
  constructor(name) {
    this.name = name;
  }
  get title() {
    return `${greet(this.name)} [core]`;
  }
}

console.log(new Core("shermes-aot").title);
console.log("m1 ok");
