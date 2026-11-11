// Stand-in for a native-only module: every export exists and does nothing.
// Capitalised exports render nothing; functions return an inert value.
function makeInert() {
  const target = function () {};
  const inert = new Proxy(target, {
    get(_t, key) {
      if (key === Symbol.toPrimitive) return (hint) => (hint === "number" ? 0 : "");
      if (key === "then") return undefined; // not a promise
      if (key === "$$typeof" || key === "prototype") return undefined;
      if (key === Symbol.iterator) return function* () {};
      if (key === "toJSON") return () => null;
      return inert;
    },
    apply() {
      return inert;
    },
    construct() {
      return inert;
    },
  });
  return inert;
}

const inert = makeInert();
const Nothing = () => null;

module.exports = new Proxy(
  { __esModule: true, __imitorStub: true },
  {
    get(base, key) {
      if (key in base) return base[key];
      if (typeof key !== "string") return undefined;
      if (key === "default") return module.exports;
      if (/^use[A-Z]/.test(key)) return () => inert;
      if (/^[A-Z]/.test(key) && !/^[A-Z0-9_]+$/.test(key)) {
        // Component-or-namespace: renders nothing, but stays callable deep down.
        return new Proxy(Nothing, { get: (t, k) => (k in t ? t[k] : inert) });
      }
      return inert;
    },
  }
);
