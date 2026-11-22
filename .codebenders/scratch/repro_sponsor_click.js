// REPRODUCE harness: sponsor click for AS-1009 / AS-1010 in #csr-console (Node, vm + DOM stub).
// app.js is loaded from an in-memory copy with one exposure line added before the final IIFE close.
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const ROOT = path.resolve(__dirname, '..', '..');
const store = {};
const ls = { getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; }, setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } };
globalThis.localStorage = ls; globalThis.window = globalThis; window.localStorage = ls;
window.print = function () {}; window.addEventListener = function () {}; window.removeEventListener = function () {};
const docL = {};
const cache = {};
class El {
  constructor(tag) { this.tagName = tag || 'DIV'; this.children = []; this.style = {}; this.dataset = {}; this.elements = {}; this.options = []; this.value = ''; this.disabled = false; this.parentNode = null; this.innerHTML = ''; this._cls = ''; this._text = ''; this._l = {};
    this.classList = { add() {}, remove() {}, toggle() { return false; }, contains() { return false; } }; }
  get className() { return this._cls; } set className(v) { this._cls = String(v); }
  get textContent() { return this._text; } set textContent(v) { this._text = String(v); }
  addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); }
  removeEventListener() {}
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  insertBefore(c) { this.children.push(c); c.parentNode = this; return c; }
  removeChild(c) { this.children = this.children.filter(function (x) { return x !== c; }); c.parentNode = null; return c; }
  setAttribute() {} getAttribute() { return null; } removeAttribute() {}
  querySelector() { return new El(); } querySelectorAll() { return []; }
  reset() {} focus() {} blur() {} scrollIntoView() {}
  closest() { return null; } contains() { return false; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; }
}
globalThis.document = {
  body: new El('BODY'), documentElement: new El('HTML'),
  getElementById(id) { if (!cache[id]) { cache[id] = new El(); cache[id].id = id; cache[id].parentNode = new El(); } return cache[id]; },
  querySelector() { return new El(); }, querySelectorAll() { return []; },
  createElement(tag) { return new El(tag); }, createTextNode(t) { const n = new El('#text'); n.textContent = t; return n; },
  addEventListener(t, f) { (docL[t] = docL[t] || []).push(f); }
};
cache['donate-form'] = new El(); cache['donate-form'].id = 'donate-form'; cache['donate-form'].parentNode = new El();
cache['donate-form'].elements.caterer = new El();
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8'), { filename: 'data.js' });
let src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const idx = src.trimEnd().lastIndexOf('})();');
if (idx < 0) { console.log('BLOCKER: final IIFE close not found'); process.exit(2); }
src = src.slice(0, idx) + 'globalThis.__t = { state: state, renderAll: renderAll, sponsoredIds: sponsoredIds };\n' + src.slice(idx);
try { vm.runInThisContext(src, { filename: 'app.js (harness copy)' }); }
catch (e) { console.log('BLOCKER: app.js failed to load: ' + e.message); process.exit(2); }
const T = globalThis.__t;
console.log('fresh load: localStorage keys=' + JSON.stringify(Object.keys(store)));
console.log('document click listeners after load: ' + (docL.click || []).length);
T.state.activeRole = 'vikram';
const clickCountBefore = (docL.click || []).length;
try { T.renderAll(); console.log('renderAll (vikram) ok'); } catch (e) { console.log('renderAll THREW: ' + e.message); }
console.log('document click listeners after render: ' + (docL.click || []).length + ' (before render: ' + clickCountBefore + ')');
const csrHtml = document.getElementById('csr-console').innerHTML;
const rendered = [];
const re = /class="sponsor-badge" data-action="sponsor" data-id="([^"]+)"/g; let m;
while ((m = re.exec(csrHtml)) !== null) rendered.push(m[1]);
console.log('rendered sponsor buttons: ' + JSON.stringify(rendered));
const statuses = {}; T.state.batches.forEach(function (b) { if (b.id === 'AS-1009' || b.id === 'AS-1010') statuses[b.id] = b.status; });
console.log('seed statuses: ' + JSON.stringify(statuses));
function click(id) {
  const attrs = { 'data-action': 'sponsor', 'data-id': id };
  const target = { getAttribute(n) { return Object.prototype.hasOwnProperty.call(attrs, n) ? attrs[n] : null; },
    closest(sel) { return sel === '[data-action]' ? target : null; }, hasAttribute(n) { return Object.prototype.hasOwnProperty.call(attrs, n); } };
  const toastHost = document.getElementById('toast-container');
  const toastsBefore = toastHost.children.length;
  const setBefore = T.sponsoredIds.size;
  const errors = [];
  (docL.click || []).forEach(function (fn) { try { fn({ target: target, preventDefault() {}, stopPropagation() {} }); } catch (e) { errors.push(e.message); } });
  const toastNew = toastHost.children.slice(toastsBefore).map(function (t) { return t.children[0].textContent + ' | ' + t.children[1].textContent; });
  console.log('CLICK ' + id + ': setBefore=' + setBefore + ' setAfter=' + T.sponsoredIds.size + ' has=' + T.sponsoredIds.has(id) +
    ' toasts=' + JSON.stringify(toastNew) + ' exceptions=' + JSON.stringify(errors));
  return { changed: T.sponsoredIds.size !== setBefore, errors: errors };
}
const r1 = click('AS-1009');
const r2 = click('AS-1010');
console.log('sponsoredIds after both clicks: ' + JSON.stringify(Array.from(T.sponsoredIds)));
const csrAfter = document.getElementById('csr-console').innerHTML;
console.log('csr shows Sponsored label after clicks: ' + /card-status">Sponsored/.test(csrAfter));
const verdictBad = [r1, r2].some(function (r) { return !r.changed || r.errors.length; });
console.log('VERDICT: ' + (verdictBad ? 'REPRODUCED (click left set unchanged or threw)' : 'NOT REPRODUCED (both clicks changed the sponsored set, no exceptions)'));
process.exit(0);