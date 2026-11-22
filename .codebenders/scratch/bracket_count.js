const fs = require('fs');
for (const f of ['app.js', 'index.html', 'styles.css']) {
  let t = fs.readFileSync(f, 'utf8');
  if (f === 'index.html') t = t.replace(/<script[\s\S]*?<\/script>/gi, '');
  const c = (ch) => t.split(ch).length - 1;
  const b = { '{': c('{'), '}': c('}'), '(': c('('), ')': c(')'), '[': c('['), ']': c(']') };
  console.log(f, JSON.stringify(b), 'braces ' + (b['{'] === b['}'] ? 'EQUAL' : 'UNEQUAL'), 'parens ' + (b['('] === b[')'] ? 'EQUAL' : 'UNEQUAL'), 'square ' + (b['['] === b[']'] ? 'EQUAL' : 'UNEQUAL'));
}
