const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const lines = (s) => s.split(/\r?\n/);
const count = (s, ch) => s.split(ch).length - 1;
const out = [];
const log = (...a) => out.push(a.join(' '));

// Step 3: bracket balance
const app = read('app.js');
const css = read('styles.css');
let html = read('index.html');
const htmlNoScript = html.replace(/<script[\s\S]*?<\/script>/gi, '');
const bal = (name, s) => {
  const b = [count(s, '{'), count(s, '}')];
  const p = [count(s, '('), count(s, ')')];
  const q = [count(s, '['), count(s, ']')];
  log(`[3] ${name}: {} ${b[0]}/${b[1]} ${b[0] === b[1] ? 'EQUAL' : 'NOT EQUAL'} | () ${p[0]}/${p[1]} ${p[0] === p[1] ? 'EQUAL' : 'NOT EQUAL'} | [] ${q[0]}/${q[1]} ${q[0] === q[1] ? 'EQUAL' : 'NOT EQUAL'}`);
};
bal('app.js', app);
bal('index.html (script blocks removed)', htmlNoScript);
bal('styles.css', css);

// Step 4: function definitions and call sites
const fns = ['renderCorridorMap', 'renderCorridorEta', 'renderRadarPopover', 'startRadarAnimation', 'bindRadarListeners', 'geoToXY'];
for (const f of fns) {
  const re = new RegExp('function\\s+' + f + '\\s*\\(', 'g');
  log(`[4] function ${f}( defs: ${(app.match(re) || []).length}`);
}
log(`[4] CORRIDOR_POS occurrences: ${(app.match(/CORRIDOR_POS/g) || []).length}`);
log(`[4] bindRadarListeners( occurrences: ${(app.match(/bindRadarListeners\(/g) || []).length}`);

// Step 5: ids
const idRe = /id\s*=\s*["']([^"']+)["']/g;
const htmlIds = {};
let m;
while ((m = idRe.exec(html)) !== null) htmlIds[m[1]] = (htmlIds[m[1]] || 0) + 1;
log(`[5] id="corridor-popover" count: ${htmlIds['corridor-popover'] || 0}`);
log(`[5] id="corridor-map" count: ${htmlIds['corridor-map'] || 0}`);
const refRe = /(?:getElementById\(\s*["']([^"']+)["']|\$\(\s*["']([^"']+)["']|querySelector\(\s*["']#([^"'\s]+)["'])/g;
const refs = new Map();
const al = lines(app);
al.forEach((ln, i) => {
  let r;
  const re = new RegExp(refRe.source, 'g');
  while ((r = re.exec(ln)) !== null) {
    const id = r[1] || r[2] || r[3];
    if (!refs.has(id)) refs.set(id, []);
    refs.get(id).push(i + 1);
  }
});
for (const [id, where] of refs) {
  if (id.startsWith('view-')) continue;
  const ok = !!htmlIds[id];
  log(`[5] ref ${id} ${ok ? 'OK' : 'MISSING in index.html'} app.js:${where.join(',')}`);
}
// dynamic $(var) calls, reported for info
al.forEach((ln, i) => {
  if (/\$\(\s*[a-zA-Z_]/.test(ln) && !/\$\(\s*["']/.test(ln)) log(`[5] dynamic $() app.js:${i + 1}: ${ln.trim()}`);
});

// Step 6: css
log(`[6] v13 marker lines: ${lines(css).map((l, i) => (/v13/.test(l) ? (i + 1) + ': ' + l.trim() : null)).filter(Boolean).join(' | ')}`);
const ruleLines = (sel) => lines(css).map((l, i) => (l.includes(sel) && /\{/.test(l) ? (i + 1) + ': ' + l.trim() : null)).filter(Boolean);
log(`[6] .corridor-popover rules: ${JSON.stringify(ruleLines('.corridor-popover'))}`);
log(`[6] .radar-route rules: ${JSON.stringify(ruleLines('.radar-route'))}`);

// Step 7: guardrail scan
const terms = ['80G', 'tax exemption', 'certif', 'illustrative', 'Synthetic demo'];
const files = { 'app.js': app, 'index.html': html, 'styles.css': css };
for (const [name, text] of Object.entries(files)) {
  lines(text).forEach((ln, i) => {
    for (const t of terms) {
      if (ln.toLowerCase().includes(t.toLowerCase())) log(`[7] ${name}:${i + 1} [${t}] ${ln.trim()}`);
    }
  });
}
// data.js is also scanned for context
lines(read('data.js')).forEach((ln, i) => {
  for (const t of terms) {
    if (ln.toLowerCase().includes(t.toLowerCase())) log(`[7] data.js:${i + 1} [${t}] ${ln.trim()}`);
  }
});

fs.writeFileSync(path.join(__dirname, 'verify_static_out.txt'), out.join('\n') + '\n');
console.log('written');
