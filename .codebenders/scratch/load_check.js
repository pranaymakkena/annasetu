// Headless load check: runs data.js then app.js (in that order, as index.html does)
// against a minimal DOM stub keyed on the element IDs in index.html.
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const root = process.cwd();
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

const elements = {};
function mk(id) {
  return {
    id,
    innerHTML: "",
    textContent: "",
    value: "",
    options: [],
    elements: {},
    attrs: {},
    classList: { toggle() {} },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    addEventListener() {},
    reset() {},
  };
}
const document = {
  getElementById(id) {
    if (!elements[id]) elements[id] = mk(id);
    return elements[id];
  },
  querySelectorAll() { return []; },
  addEventListener() {},
};
const win = {};
const sandbox = {
  window: win,
  document,
  console,
  Date,
  Math,
  Number,
  String,
  Object,
  Array,
  isFinite,
  isNaN,
  setInterval() { return 0; }, // no-op: keep the process from hanging
  clearInterval() {},
};
sandbox.window = win;
vm.createContext(sandbox);

let ok = true;
for (const f of ["data.js", "app.js"]) {
  try {
    vm.runInContext(read(f), sandbox, { filename: f });
    console.log("LOADED", f);
  } catch (err) {
    ok = false;
    console.log("ERROR while loading", f, "->", err && err.stack);
  }
}

const D = win.AnnaSetuData;
console.log("AnnaSetuData present:", !!D);
if (D) {
  console.log("DISCLAIMER matches legal-text:", elements["legal-text"].textContent === D.DISCLAIMER);
  console.log("legal-text:", JSON.stringify(elements["legal-text"].textContent));
}
console.log("locality-select options html length:", elements["locality-select"].innerHTML.length);
console.log("caterer-list html length:", elements["caterer-list"].innerHTML.length);
console.log("feed-posted html length:", elements["feed-posted"].innerHTML.length);
console.log("feed-active html length:", elements["feed-active"].innerHTML.length);
console.log("ngo-panel html length:", elements["ngo-panel"].innerHTML.length);
console.log("impact-stats html length:", elements["impact-stats"].innerHTML.length);
console.log("ledger-body rows:", (elements["ledger-body"].innerHTML.match(/<tr>/g) || []).length);
console.log("roi-out html length:", elements["roi-out"].innerHTML.length);
console.log("expires-input value:", elements["expires-input"].value);
console.log("caterer-filter html length:", elements["caterer-filter"].innerHTML.length);
console.log(ok ? "LOAD RESULT: PASS (no exceptions)" : "LOAD RESULT: FAIL");
process.exitCode = ok ? 0 : 1;
