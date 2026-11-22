const fs = require("fs");
const s = fs.readFileSync("index.html", "utf8");
const ids = ["header-search-input","header-locality-select","role-select","whatsapp-toggle","btn-guided-demo","city-status-pill","sim-dock","sim-scenario","sim-reset"];
for (const id of ids) {
  const n = s.split('id="' + id + '"').length - 1;
  console.log(id, n, n === 1 ? "OK" : "NOT-EXACTLY-ONCE");
}
