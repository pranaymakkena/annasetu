// REPRODUCE harness: AS-1005 "was not claimed" via Simulate Live Rescue.
// Loads data.js and app.js under Node with DOM/localStorage stubs. No browser, no project edits.
// app.js is an IIFE with no exports, so the harness exposes internals in-memory by
// inserting one line before the final "})();" of the source it loads (the file on disk is untouched).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const toastTexts = [];

class El {
  constructor(tag) {
    this.tagName = tag || 'DIV';
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.elements = {};
    this.options = [];
    this.value = '';
    this.disabled = false;
    this.parentNode = null;
    this.innerHTML = '';
    this._cls = '';
    this._text = '';
    this.classList = { add() {}, remove() {}, toggle() { return false; }, contains() { return false; } };
  }
  get className() { return this._cls; }
  set className(v) { this._cls = String(v); }
  get textContent() { return this._text; }
  set textContent(v) {
    this._text = String(v);
    if (this._cls === 'toast-title' || this._cls === 'toast-detail') toastTexts.push(this._cls + ': ' + this._text);
  }
  addEventListener() {}
  removeEventListener() {}
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  removeChild(c) { this.children = this.children.filter(function (x) { return x !== c; }); c.parentNode = null; return c; }
  setAttribute() {}
  getAttribute() { return null; }
  removeAttribute() {}
  querySelector() { return new El(); }
  querySelectorAll() { return []; }
  focus() {}
  blur() {}
  scrollIntoView() {}
  closest() { return null; }
  contains() { return false; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; }
}

const store = {};
const localStorageStub = {
  getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem(k, v) { store[k] = String(v); },
  removeItem(k) { delete store[k]; }
};

globalThis.localStorage = localStorageStub;
globalThis.window = globalThis;
globalThis.document = {
  body: new El('BODY'),
  documentElement: new El('HTML'),
  getElementById() { const e = new El(); e.parentNode = new El(); return e; },
  querySelector() { return new El(); },
  querySelectorAll() { return []; },
  createElement(tag) { return new El(tag); },
  createTextNode(t) { const n = new El('#text'); n.textContent = t; return n; },
  addEventListener() {}
};
globalThis.window.localStorage = localStorageStub;
globalThis.window.print = function () {};

// 1) data.js (sets window.AnnaSetuData)
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8'), { filename: 'data.js' });
const D = globalThis.AnnaSetuData;

// 2) Seed localStorage with the stale saved state: the seed batch list, AS-1005 as Delivered.
const now = Date.now();
const seedBatches = D.buildSeedBatches(now);
seedBatches.forEach(function (b) {
  if (b.caterer && typeof b.caterer === 'object') { b.catererPhone = b.caterer.phone; b.caterer = b.caterer.name; }
});
const as1005Seed = seedBatches.filter(function (b) { return b.id === 'AS-1005'; })[0];
localStorageStub.setItem('annasetu_db_v1', JSON.stringify({
  batches: seedBatches, nextNum: 1009, activeRole: '', savedAt: now
}));
console.log('SEEDED AS-1005 status in localStorage: ' + as1005Seed.status);

// 3) app.js with exposure line injected before the final "})();" (in memory only)
let appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const tail = '})();';
const idx = appSrc.trimEnd().lastIndexOf(tail);
if (idx < 0) throw new Error('harness: could not find final IIFE close in app.js');
appSrc = appSrc.slice(0, idx) +
  'globalThis.__t = { onSimulateRescue: onSimulateRescue, claimBatch: claimBatch, findOpenPostedBatch: findOpenPostedBatch, state: state };\n' +
  appSrc.slice(idx);
vm.runInThisContext(appSrc, { filename: 'app.js (harness-exposed copy)' });
const T = globalThis.__t;
if (!T) throw new Error('harness: __t not exposed');

// 4) Which batch will onSimulateRescue pick?
const picked = T.findOpenPostedBatch(Date.now());
console.log('findOpenPostedBatch selects: ' + (picked ? picked.id + ' status=' + picked.status : 'null (createDemoBatch would run)'));

// 5) Run the scenario
let thrown = null;
try {
  T.onSimulateRescue();
  console.log('onSimulateRescue() returned without throwing');
} catch (err) {
  thrown = err;
  console.log('onSimulateRescue() THREW: ' + err.message);
  console.log(String(err.stack).split('\n').slice(0, 3).join('\n'));
}

// 6) Wait for the step timer (SIM_STEP_MS = 1800) and the toast
setTimeout(function () {
  console.log('--- toasts after rescue step ---');
  toastTexts.forEach(function (t) { console.log(t); });
  const sel = picked ? T.state.batches.filter(function (b) { return b.id === picked.id; })[0] : null;
  const a1005 = T.state.batches.filter(function (b) { return b.id === 'AS-1005'; })[0];
  console.log('selected batch after run: ' + (sel ? sel.id + ' status=' + sel.status + ' dispatchNote=' + JSON.stringify(sel.dispatchNote) : 'none'));
  console.log('AS-1005 after run: status=' + (a1005 ? a1005.status : 'missing'));
  console.log('state.feedMsg: ' + T.state.feedMsg);
  process.exit(0);
}, 2600);


