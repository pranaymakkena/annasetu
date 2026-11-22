// REPRODUCE harness: (b) duplicate batch IDs on a fresh load (createDemoBatch vs seed AS-1009/AS-1010)
// and (a) CSR sponsor banner with no role selected.
// Loads data.js and app.js under Node with DOM/localStorage stubs. Project files are not edited;
// app.js is read into memory and one exposure line is inserted before the final IIFE close.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');

// Element cache so getElementById returns the same object each time (state such as .hidden persists).
const cache = {};
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
  set textContent(v) { this._text = String(v); }
  addEventListener() {}
  removeEventListener() {}
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  insertBefore(c) { this.children.push(c); c.parentNode = this; return c; }
  removeChild(c) { this.children = this.children.filter(function (x) { return x !== c; }); c.parentNode = null; return c; }
  setAttribute() {}
  getAttribute() { return null; }
  removeAttribute() {}
  querySelector() { return new El(); }
  querySelectorAll() { return []; }
  reset() {}
  focus() {}
  blur() {}
  scrollIntoView() {}
  closest() { return null; }
  contains() { return false; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; }
}

// Fresh load: empty localStorage.
const store = {};
const localStorageStub = {
  getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem(k, v) { store[k] = String(v); },
  removeItem(k) { delete store[k]; }
};
globalThis.localStorage = localStorageStub;
globalThis.window = globalThis;
globalThis.window.localStorage = localStorageStub;
globalThis.window.print = function () {};
globalThis.window.addEventListener = function () {};
globalThis.window.removeEventListener = function () {};
globalThis.document = {
  body: new El('BODY'),
  documentElement: new El('HTML'),
  getElementById(id) {
    if (!cache[id]) {
      cache[id] = new El();
      cache[id].id = id;
      cache[id].parentNode = new El();
    }
    return cache[id];
  },
  querySelector() { return new El(); },
  querySelectorAll() { return []; },
  createElement(tag) { return new El(tag); },
  createTextNode(t) { const n = new El('#text'); n.textContent = t; return n; },
  addEventListener() {}
};

// Stub the donate form's named 'caterer' field, which submitDonateBatch reads (app.js:830).
cache['donate-form'] = new El();
cache['donate-form'].id = 'donate-form';
cache['donate-form'].parentNode = new El();
cache['donate-form'].elements.caterer = new El();
// 1) data.js (sets window.AnnaSetuData)
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8'), { filename: 'data.js' });

// 2) app.js with exposure line inserted before the final "})();" (in memory only)
let appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const tail = '})();';
const idx = appSrc.trimEnd().lastIndexOf(tail);
if (idx < 0) throw new Error('harness: could not find final IIFE close in app.js');
appSrc = appSrc.slice(0, idx) +
  'globalThis.__t = { state: state, createDemoBatch: createDemoBatch, renderAll: renderAll, renderPersona: renderPersona };\n' +
  appSrc.slice(idx);
try {
  vm.runInThisContext(appSrc, { filename: 'app.js (harness-exposed copy)' });
} catch (err) {
  console.log('BLOCKER: app.js failed to load: ' + err.message);
  console.log(String(err.stack).split('\n').slice(0, 4).join('\n'));
  process.exit(2);
}
const T = globalThis.__t;
if (!T) { console.log('BLOCKER: __t not exposed'); process.exit(2); }

console.log('localStorage keys after boot (fresh load): ' + JSON.stringify(Object.keys(store)));

// ---------- (a) CSR banner with no role ----------
console.log('--- (a) CSR banner, no role selected ---');
console.log('state.activeRole = ' + JSON.stringify(T.state.activeRole));
try {
  T.renderAll();
  console.log('renderAll() returned normally');
} catch (err) {
  console.log('renderAll() THREW: ' + err.message);
}
const banner = document.getElementById('persona-banner');
const csr = document.getElementById('csr-console');
console.log('persona-banner hidden=' + String(banner.hidden) + ' textContent=' + JSON.stringify(banner.textContent));
console.log('csr-console hidden=' + String(csr.hidden));

// ---------- (b) batch ids on fresh load ----------
console.log('--- (b) batch ids, fresh load ---');
const seedIds = T.state.batches.map(function (b) { return b.id; });
console.log('state.nextNum before = ' + T.state.nextNum);
console.log('seed ids in state.batches (' + seedIds.length + '): ' + seedIds.join(','));
const seedSet = {};
seedIds.forEach(function (id) { seedSet[id] = true; });

const created = [];
for (let i = 1; i <= 3; i++) {
  const before = T.state.batches.length;
  let ret;
  try {
    ret = T.createDemoBatch();
  } catch (err) {
    console.log('call ' + i + ' THREW: ' + err.message); console.log(String(err.stack).split('\n').slice(0, 4).join('\n'));
    break;
  }
  const grew = T.state.batches.length - before;
  // Newest batch is the one just pushed; identify it by the last element.
  const newest = T.state.batches[T.state.batches.length - 1];
  const id = newest ? newest.id : null;
  const occurrences = T.state.batches.filter(function (b) { return b.id === id; }).length;
  created.push(id);
  console.log('call ' + i + ': returned=' + JSON.stringify(ret) +
    ' batchesGrew=' + grew +
    ' newestId=' + id +
    ' equalsSeedId=' + String(!!seedSet[id]) +
    ' occurrencesInBatches=' + occurrences +
    ' nextNum after=' + T.state.nextNum);
}
const collided = created.filter(function (id) { return seedSet[id]; });
console.log('created ids: ' + JSON.stringify(created));
console.log('VERDICT (b): ' + (collided.length ? 'REPRODUCED (created id equals seed id: ' + collided.join(',') + ')' : 'NOT REPRODUCED'));
process.exit(0);
