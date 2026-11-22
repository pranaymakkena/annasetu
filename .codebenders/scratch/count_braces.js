const fs = require('fs');
for (const f of ['app.js', 'styles.css']) {
  const src = fs.readFileSync(f, 'utf8');
  const count = (ch) => src.split(ch).length - 1;
  console.log(f, 'braces { }:', count('{'), count('}'), 'diff', count('{') - count('}'),
    '| parens ( ):', count('('), count(')'), 'diff', count('(') - count(')'));
}
