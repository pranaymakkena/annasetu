// REPRODUCE: fresh tab (localStorage empty), first Simulate Live Rescue click. Scratch only.
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const ROOT = path.resolve(__dirname, '..', '..');
const mode = process.argv[2] || 'scenario';
const toasts = [];
process.on('uncaughtException', function (e) { console.log('UNCAUGHT: ' + e.message); process.exit(1); });
class El {
  constructor(tag) { this.tagName = tag || 'DIV'; this.children = []; this.style = {}; this.dataset = {}; this.elements = {}; this.options = []; this.value = ''; this.disabled = false; this.parentNode = null; this.innerHTML = ''; this._cls = ''; this._text = ''; this.classList = { add() {}, remove() {}, toggle() { return false; }, contains() { return false; } }; }
  get className() { return this._cls; } set className(v) { this._cls = String(v); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); if (this._cls === 'toast-title' || this._cls === 'toast-detail') toasts.push(this._cls + ': ' + this._text); }
  addEventListener() {} removeEventListener() {}
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  removeChild(c) { this.children = this.children.filter(function (x) { return x !== c; }); c.parentNode = null; return c; }
  setAttribute() {} getAttribute() { return null; } removeAttribute() {}
  querySelector() { return new El(); } querySelectorAll() { return []; }
  focus() {} blur() {} scrollIntoView() {} closest() { return null; } contains() { return false; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; }
}
const store = {};
const ls = {
  getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; }
};
const cache = {};
function byId(id) {
  if (!cache[id]) { const e = new El(); e.parentNode = new El(); if (id === 'donate-form') e.elements = { caterer: new El() }; cache[id] = e; }
  return cache[id];
}
globalThis.localStorage = ls;
globalThis.window = globalThis;
globalThis.window.localStorage = ls;
globalThis.window.print = function () {};
globalThis.document = {
  body: new El('BODY'), documentElement: new El('HTML'),
  getElementById: byId, querySelector() { return new El(); }, querySelectorAll() { return []; },
  createElement(t) { return new El(t); }, createTextNode(t) { const n = new El('#text'); n.textContent = t; return n; },
  addEventListener() {}
};
// 1) fresh load: localStorage must be empty
const keysBefore = Object.keys(store);
console.log('localStorage keys before load: ' + JSON.stringify(keysBefore));
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8'), { filename: 'data.js' });
let appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const tail = '})();';
const idx = appSrc.trimEnd().lastIndexOf(tail);
if (idx < 0) throw new Error('harness: final IIFE close not found');
appSrc = appSrc.slice(0, idx) +
  'globalThis.__t = { onSimulateRescue: onSimulateRescue, createDemoBatch: createDemoBatch, findOpenPostedBatch: findOpenPostedBatch, findBatch: findBatch, state: state };\n' +
  appSrc.slice(idx);
vm.runInThisContext(appSrc, { filename: 'app.js (harness-exposed copy)' });
const T = globalThis.__t;
const now = Date.now();
if (mode === 'demo') {
  console.log('nextNum before createDemoBatch: ' + T.state.nextNum);
  console.log('batch ids before: ' + T.state.batches.map(function (b) { return b.id; }).join(','));
  let r = null;
  try { r = T.createDemoBatch(); } catch (e) { console.log('createDemoBatch THREW: ' + e.message); }
  console.log('createDemoBatch returned id: ' + (r ? r.id : 'null'));
  console.log('nextNum after: ' + T.state.nextNum);
  console.log('count of batches with id AS-1009 after: ' + T.state.batches.filter(function (b) { return b.id === 'AS-1009'; }).length);
  console.log('AS-1009 entries: ' + JSON.stringify(T.state.batches.filter(function (b) { return b.id === 'AS-1009'; }).map(function (b) { return { status: b.status, caterer: b.caterer }; })));
  process.exit(0);
}
// scenario
console.log('state.nextNum before click: ' + T.state.nextNum);
console.log('batches before click (id status expiresAt-minus-now min):');
T.state.batches.forEach(function (b) { console.log('  ' + b.id + ' ' + b.status + ' ' + ((b.expiresAt - now) / 60000).toFixed(1) + (b.locked ? ' locked' : '')); });
const picked = T.findOpenPostedBatch(Date.now());
console.log('findOpenPostedBatch(Date.now()) returns: ' + (picked ? picked.id + ' status=' + picked.status : 'null'));
console.log('Posted seeds already expired with real clock: ' + JSON.stringify(T.state.batches.filter(function (b) { return b.status === 'Posted' && b.expiresAt <= Date.now(); }).map(function (b) { return b.id; })));
try { T.onSimulateRescue(); console.log('onSimulateRescue() returned without throwing'); }
catch (e) { console.log('onSimulateRescue() THREW: ' + e.message); }
setTimeout(function () {
  console.log('--- toasts (title/detail) ---');
  toasts.forEach(function (t) { console.log(t); });
  console.log('--- batches after run ---');
  T.state.batches.forEach(function (b) { if (b.id === 'AS-1005' || (picked && b.id === picked.id) || b.status !== (b.origStatus)) console.log('  ' + b.id + ' ' + b.status + (b.dispatchNote ? ' dispatchNote=' + b.dispatchNote : '')); });
  console.log('state.feedMsg: ' + T.state.feedMsg);
  console.log('AS-1005 status: ' + (T.state.batches.filter(function (b) { return b.id === 'AS-1005'; })[0] || {}).status);
  process.exit(0);
}, 6200);

