const h = require('fs').readFileSync('index.html', 'utf8');
const c = r => (h.match(r) || []).length;
console.log(JSON.stringify({
  navBadge: c(/nav-badge/g),
  dataView: c(/data-view=/g),
  legalText: c(/id="legal-text"/g),
  navItemWithDataView: c(/class="[^"]*nav-item[^"]*"[^>]*data-view="/g)
}));
