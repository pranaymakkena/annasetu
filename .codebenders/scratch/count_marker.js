const fs = require('fs');
const src = fs.readFileSync('styles.css', 'utf8');
const marker = '/* ===== v11 radar legend \u0026 route cards ===== */';
console.log('exact marker count:', src.split(marker).length - 1);
src.split(/\r?\n/).forEach((l, i) => { if (/v11 radar legend/i.test(l)) console.log('line', i + 1, JSON.stringify(l)); });
