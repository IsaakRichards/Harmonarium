// Small stand-ins for newer JavaScript the reading engine (src/foliate) uses, for older webviews:
// Sailfish OS's Gecko and Android phones whose system WebView hasn't been updated in a while.
// Loaded first (see main.js). Each one only fills a gap; engines that have the real thing keep it.

const define = (obj, name, fn) => {
  if (!(name in obj)) Object.defineProperty(obj, name, { value: fn, writable: true, configurable: true });
};

function at(i) {
  const n = Math.trunc(i) || 0;
  const k = n < 0 ? this.length + n : n;
  return k < 0 || k >= this.length ? undefined : this[k];
}
define(Array.prototype, "at", at);
define(String.prototype, "at", at);

define(Array.prototype, "findLast", function (fn, self) {
  for (let i = this.length - 1; i >= 0; i--) if (fn.call(self, this[i], i, this)) return this[i];
  return undefined;
});
define(Array.prototype, "findLastIndex", function (fn, self) {
  for (let i = this.length - 1; i >= 0; i--) if (fn.call(self, this[i], i, this)) return i;
  return -1;
});

define(Object, "groupBy", (items, fn) => {
  const out = Object.create(null);
  let i = 0;
  for (const x of items) { const k = fn(x, i++); (out[k] ||= []).push(x); }
  return out;
});
define(Map, "groupBy", (items, fn) => {
  const out = new Map();
  let i = 0;
  for (const x of items) {
    const k = fn(x, i++);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(x);
  }
  return out;
});

define(String.prototype, "replaceAll", function (search, replacement) {
  if (search instanceof RegExp) return this.replace(search, replacement);
  return this.split(String(search)).join(typeof replacement === "function" ? replacement(String(search)) : replacement);
});
