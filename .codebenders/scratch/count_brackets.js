const fs = require("fs");
for (const f of ["app.js", "styles.css"]) {
  const s = fs.readFileSync(f, "utf8");
  const n = {};
  for (const ch of "{}()[]") n[ch] = s.split(ch).length - 1;
  console.log(f, JSON.stringify(n));
  console.log("  braces equal:", n["{"] === n["}"], " parens equal:", n["("] === n[")"], " brackets equal:", n["["] === n["]"]);
}
