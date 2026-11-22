const fs = require("fs");
function scan(file, isCss) {
  const s = fs.readFileSync(file, "utf8");
  let i = 0, depth = 0, pd = 0, minDepth = 0, comments = 0, strings = 0, unclosed = null;
  while (i < s.length) {
    const c = s[i], n = s[i+1];
    if (c === "/" && n === "*") { const e = s.indexOf("*/", i+2); if (e < 0) { unclosed = "comment at " + i; break; } comments++; i = e + 2; continue; }
    if (c === '"' || c === "'") { let j = i+1; while (j < s.length && s[j] !== c && s[j] !== "\n") { if (s[j] === "\\") j++; j++; } if (s[j] !== c) { unclosed = "string at char " + i; break; } strings++; i = j+1; continue; }
    if (c === "{") depth++; else if (c === "}") { depth--; if (depth < minDepth) minDepth = depth; }
    else if (c === "(") pd++; else if (c === ")") { pd--; if (pd < minDepth) minDepth = pd; }
    i++;
  }
  console.log(file, "comments=" + comments, "strings=" + strings, "braceDepthEnd=" + depth, "parenDepthEnd=" + pd, "minDepth=" + minDepth, unclosed ? "UNCLOSED: " + unclosed : "no unclosed comment/string", (depth === 0 && pd === 0 && !unclosed) ? "PASS" : "FAIL");
}
scan("styles.css", true);
scan("app.js", false);
