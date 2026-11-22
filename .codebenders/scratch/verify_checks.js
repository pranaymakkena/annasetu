const fs = require('fs');
const path = require('path');
const root = process.cwd();
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const app = read('app.js');
const html = read('index.html');
const css = read('styles.css');
const count = (s, ch) => s.split(ch).length - 1;

const section = process.argv[2] || 'all';
const out = {};

if (section === 'all' || section === 'balance') {
  for (const [name, src] of [['app.js', app], ['styles.css', css]]) {
    out[name] = { braces: [count(src,'{'), count(src,'}')], parens: [count(src,'('), count(src,')')], squares: [count(src,'['), count(src,']')] };
  }
}

if (section === 'all' || section === 'ids') {
  const htmlIds = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  const freq = {};
  htmlIds.forEach(id => freq[id] = (freq[id]||0)+1);
  out.duplicateHtmlIds = Object.entries(freq).filter(([,c]) => c > 1);
  const refs = new Set();
  const dyn = new Set();
  for (const m of app.matchAll(/getElementById\(\s*['"`]([^'"`]+)['"`]\s*\)/g)) refs.add(m[1]);
  for (const m of app.matchAll(/\$\(\s*['"`]#([^'"`]+)['"`]\s*\)/g)) refs.add(m[1]);
  for (const m of app.matchAll(/querySelector(All)?\(\s*['"`]#([^'"`\s\]\[]+)/g)) refs.add(m[2]);
  for (const m of app.matchAll(/getElementById\(\s*([^'"`\s)][^)]*)\)/g)) dyn.add('DYNAMIC: ' + m[1].trim());
  const htmlSet = new Set(htmlIds);
  out.missingIdsInHtml = [...refs].filter(id => !htmlSet.has(id));
  out.dynamicLookups = [...dyn];
}

if (section === 'all' || section === 'data') {
  global.window = {};
  require(path.join(root, 'data.js'));
  const D = global.window.AnnaSetuData;
  out.ngoCount = D.NGOS.length;
  out.ngoIds = D.NGOS.map(n => n.id);
  const batches = D.buildSeedBatches(Date.now());
  out.seedBatchCount = batches.length;
  out.seedBatches = batches.map(b => `${b.id} | ${b.status} | ${b.kg ?? b.qty ?? '?'} | ${b.locality}`);
}

if (section === 'all' || section === 'funcs') {
  const names = ['renderNavBadges','renderPersona','renderCorridorMap','renderCorridorEta','renderNgoNetwork','renderCapacityBars','renderSplitClaim','renderSafety','renderEsgKpis','renderEsgMethodology'];
  const lines = app.split('\n');
  out.defs = {};
  out.renderAllCalls = {};
  const renderAllStart = lines.findIndex(l => /function\s+renderAll\s*\(/.test(l));
  out.renderAllStart = renderAllStart + 1;
  let renderAllEnd = lines.length;
  for (let i = renderAllStart + 1; i < lines.length; i++) { if (/^}/.test(lines[i])) { renderAllEnd = i; break; } }
  out.renderAllEnd = renderAllEnd + 1;
  for (const n of names) {
    out.defs[n] = lines.map((l,i)=>[l,i+1]).filter(([l]) => new RegExp('function\\s+' + n + '\\s*\\(').test(l)).map(([,i])=>i);
    out.renderAllCalls[n] = lines.map((l,i)=>[l,i+1]).filter(([l,i]) => i-1 > renderAllStart && i-1 < renderAllEnd && new RegExp('\\b' + n + '\\s*\\(').test(l)).map(([,i])=>i);
  }
}

if (section === 'all' || section === 'guard') {
  const pats = ['80G','tax','certif','legal','Synthetic demo','illustrative','not financial advice'];
  const files = { 'index.html': html, 'styles.css': css, 'app.js': app };
  out.hits = [];
  for (const [f, src] of Object.entries(files)) {
    src.split('\n').forEach((line, i) => {
      for (const p of pats) if (line.toLowerCase().includes(p.toLowerCase())) out.hits.push(`${f}:${i+1} [${p}] ${line.trim().slice(0,160)}`);
    });
  }
  const lt = html.search(/id="legal-text"/);
  const ltLine = lt >= 0 ? html.slice(0, lt).split('\n').length : -1;
  out.legalTextLine = ltLine;
}

if (section === 'all' || section === 'actions') {
  const acts = ['csr-cert','confirm-receipt','rider-arrive','rider-log-temp','rider-handover','sponsor','split-claim','priority-alert'];
  out.actions = {};
  const lines = app.split('\n');
  for (const a of acts) out.actions[a] = lines.map((l,i)=>[l,i+1]).filter(([l]) => l.includes(a)).map(([,i])=>i);
}

console.log(JSON.stringify(out, null, 2));
