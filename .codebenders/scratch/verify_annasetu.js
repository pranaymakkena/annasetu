// Read-only verification helper for AnnaSetu. Writes nothing into the project.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;
const sect = (t) => console.log('\n==== ' + t + ' ====');

const app = read('app.js');
const html = read('index.html');
const css = read('styles.css');
const readme = read('README.md');
const appLines = app.split('\n');

// ---- 2. bracket counts (raw character counts) ----
sect('2. Bracket counts');
for (const [name, txt] of [['app.js', app], ['styles.css', css]]) {
  const c = (ch) => txt.split(ch).length - 1;
  console.log(`${name}: { ${c('{')} } ${c('}')} | ( ${c('(')} ) ${c(')')} | [ ${c('[')} ] ${c(']')}`);
}

// ---- 3. render function definitions and call sites ----
sect('3. Render functions');
const renderNames = ['renderCorridorMap', 'renderCorridorEta', 'renderNgoNetwork', 'renderSafety'];
for (const name of renderNames) {
  const defs = [];
  const calls = [];
  appLines.forEach((ln, i) => {
    if (new RegExp('function\\s+' + name + '\\s*\\(').test(ln)) defs.push(i + 1);
    else if (new RegExp('\\b' + name + '\\s*\\(').test(ln)) calls.push(i + 1);
  });
  // nearest preceding column-0 function for each call site
  const enclosing = calls.map((ln) => {
    for (let j = ln - 1; j >= 0; j--) {
      const m = /^function\s+(\w+)\s*\(/.exec(appLines[j]);
      if (m) return `${ln}(in ${m[1]})`;
    }
    return `${ln}(top)`;
  });
  console.log(`${name}: definitions at [${defs.join(',')}] count=${defs.length}; call/reference lines: ${enclosing.join(' ')}`);
}
const viewRe = /\b(radar|ngos|safety)\s*:/g;
const viewLines = [];
appLines.forEach((ln, i) => { if (/\b(radar|ngos|safety)\s*:/.test(ln)) viewLines.push(`${i + 1}: ${ln.trim().slice(0, 110)}`); });
console.log('view-key lines (radar/ngos/safety):\n  ' + viewLines.join('\n  '));

// ---- 4 & 5. ids ----
sect('5. Duplicate ids in index.html');
const idRe = /\sid\s*=\s*["']([^"']+)["']/g;
const htmlIds = {};
let m;
while ((m = idRe.exec(html))) {
  (htmlIds[m[1]] = htmlIds[m[1]] || []).push(lineOf(html, m.index));
}
const dups = Object.entries(htmlIds).filter(([, v]) => v.length > 1);
console.log(`unique html ids: ${Object.keys(htmlIds).length}; duplicates: ${dups.length ? dups.map(([k, v]) => k + '@' + v.join('/')).join(', ') : 'NONE'}`);

sect('4. ids referenced in app.js but missing from index.html');
const refPatterns = [
  { label: 'getElementById', re: /getElementById\(\s*["'`]([^"'`]+)["'`]/g },
  { label: '$()', re: /\$\(\s*["'`]#?([^"'`]+)["'`]/g },
  { label: 'querySelector', re: /querySelector(?:All)?\(\s*["'`]#([^"'`\s\]]+)/g },
];
const missing = [];
const dynamic = [];
const found = [];
for (const { label, re } of refPatterns) {
  re.lastIndex = 0;
  while ((m = re.exec(app))) {
    const id = m[1];
    const line = lineOf(app, m.index);
    if (id.includes('${')) { dynamic.push(`${label} line ${line}: ${id}`); continue; }
    if (htmlIds[id]) found.push(`${id}`);
    else missing.push(`${label} line ${line}: "${id}"`);
  }
}
const nonLiteral = app.split('\n').filter((l) => /getElementById\((?!\s*["'`])/.test(l)).length;
console.log('referenced literal ids resolving to index.html: ' + [...new Set(found)].length);
console.log('MISSING from index.html: ' + (missing.length ? '\n  ' + missing.join('\n  ') : 'NONE'));
console.log('dynamic (template) ids: ' + (dynamic.length ? '\n  ' + dynamic.join('\n  ') : 'none'));
console.log('getElementById calls with non-literal argument: ' + nonLiteral);

// ---- 6. direct children of .app-shell ----
sect('6. Direct children of .app-shell (index.html)');
let src = html.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
src = src.replace(/(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2>)/gi, (all, a, b, c, d) => a + c.replace(/[^\n]/g, ' ') + d);
const voids = new Set(['meta', 'link', 'input', 'img', 'br', 'hr', 'source', 'area', 'base', 'col', 'embed', 'param', 'track', 'wbr']);
const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const stack = [];
let shellLevel = -1;
const children = [];
while ((m = tagRe.exec(src))) {
  const closing = m[1] === '/';
  const name = m[2].toLowerCase();
  const attrs = m[3] || '';
  const selfClose = /\/\s*$/.test(attrs);
  const line = lineOf(src, m.index);
  if (closing) {
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k].name === name) {
        if (stack[k].shell) shellLevel = -1;
        stack.length = k;
        break;
      }
    }
    continue;
  }
  if (voids.has(name) || selfClose) continue;
  const idM = /\sid\s*=\s*["']([^"']+)["']/.exec(' ' + attrs);
  const clsM = /\sclass\s*=\s*["']([^"']+)["']/.exec(' ' + attrs);
  const isShell = !!(clsM && clsM[1].split(/\s+/).includes('app-shell'));
  if (shellLevel !== -1 && stack.length === shellLevel) {
    children.push(`${line}: <${name}${idM ? ' #' + idM[1] : ''}${clsM ? ' .' + clsM[1].split(/\s+/).join('.') : ''}>`);
  }
  stack.push({ name, shell: isShell, line });
  if (isShell) shellLevel = stack.length;
}
console.log(children.length ? children.join('\n') : 'NO .app-shell found or no children');
console.log('expected order: header.app-header, aside.sidebar, div.main-col, aside#live-queue-rail');

// ---- 7. styles.css markers and selectors ----
sect('7. styles.css markers and selectors');
const cssLines = css.split('\n');
cssLines.forEach((ln, i) => { if (/\bv9\b|\bv10\b/i.test(ln)) console.log(`${i + 1}: ${ln.trim().slice(0, 110)}`); });
const selectors = ['.route-card', '.radar-legend', '.card-body', '.ngo-card-footer', '.safety-time', '.capacity-fill'];
for (const s of selectors) {
  const re = new RegExp(s.replace('.', '\\.') + '(?![\\w-])', 'g');
  const hits = [];
  let mm;
  while ((mm = re.exec(css))) hits.push(lineOf(css, mm.index));
  console.log(`${s}: ${hits.length} hit(s) at lines [${hits.join(',')}]`);
}

// ---- 8. guardrail scan ----
sect('8. Guardrail scan (case-insensitive)');
const terms = ['80G', 'tax exemption', 'certif', 'Synthetic demo', 'illustrative', 'not financial advice'];
const files = { 'app.js': app, 'index.html': html, 'styles.css': css, 'README.md': readme };
for (const [fname, txt] of Object.entries(files)) {
  const lines = txt.split('\n');
  lines.forEach((ln, i) => {
    for (const t of terms) {
      if (ln.toLowerCase().includes(t.toLowerCase())) {
        const t2 = ln.trim();
        const isComment = /^(\/\/|\/\*|\*|<!--)/.test(t2) || /\/\/.*$/.test(t2) && ln.indexOf('//') < ln.toLowerCase().indexOf(t.toLowerCase());
        console.log(`${fname}:${i + 1} [${t}] ${isComment ? 'COMMENT' : 'CODE/PROSE'} :: ${t2.slice(0, 120)}`);
      }
    }
  });
}

// ---- 9. data-action values ----
sect('9. data-action values in app.js');
for (const v of ['csr-cert', 'confirm-receipt', 'rider-arrive', 'rider-log-temp', 'rider-handover', 'sponsor', 'split-claim', 'priority-alert']) {
  const hits = [];
  appLines.forEach((ln, i) => { if (ln.includes(v)) hits.push(i + 1); });
  console.log(`${v}: ${hits.length ? 'FOUND at ' + hits.join(',') : 'MISSING'}`);
}
