const fs = require("fs");
for (const f of process.argv.slice(2)) {
  const src = fs.readFileSync(f, "utf8");
  const c = { "{": 0, "}": 0, "(": 0, ")": 0, "[": 0, "]": 0 };
  for (const ch of src) if (ch in c) c[ch]++;
  console.log(f, "{ " + c["{"] + " } " + c["}"], "( " + c["("] + " ) " + c[")"], "[ " + c["["] + " ] " + c["]"]);
}
