// Validate repository-owned Markdown without fetching external links or
// traversing the pinned upstream, dependencies, or local runtime history.
import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";

const root = process.cwd();
const excluded = new Set([
  ".git", "node_modules", "pi", "dist", "build", "target",
  ".grapher", ".pi", ".agents", ".venv", "venv", "__pycache__",
]);
const files = [];
function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name) || entry.name.startsWith(".grapher-verify")) continue;
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(location);
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(location);
  }
}
collect(root);
files.sort();

const scripts = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts;
const errors = [];
const anchorCache = new Map();
let localLinks = 0;
function plainText(tokens) {
  return tokens.map((token) => {
    if (token.type === "html") return "";
    if (token.tokens) return plainText(token.tokens);
    return token.text ?? token.raw ?? "";
  }).join("");
}
function anchors(file) {
  if (anchorCache.has(file)) return anchorCache.get(file);
  const text = fs.readFileSync(file, "utf8");
  const result = new Set();
  const counts = new Map();
  marked.walkTokens(marked.lexer(text), (token) => {
    if (token.type !== "heading") return;
    const base = plainText(token.tokens ?? []).toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, "").replace(/ /g, "-");
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    result.add(count ? `${base}-${count}` : base);
  });
  for (const match of text.matchAll(/<(?:a|h[1-6])\b[^>]*\b(?:id|name)=["']([^"']+)["']/gi)) {
    result.add(match[1]);
  }
  anchorCache.set(file, result);
  return result;
}
for (const file of files) {
  const label = path.relative(root, file).split(path.sep).join("/");
  const text = fs.readFileSync(file, "utf8");
  marked.walkTokens(marked.lexer(text), (token) => {
    if (!["link", "image"].includes(token.type)) return;
    const href = token.href;
    if (/^[a-z][\w+.-]*:/i.test(href) || href.startsWith("//")) return;
    const [relative, fragment] = href.split("#");
    try {
      const target = relative
        ? path.resolve(path.dirname(file), decodeURIComponent(relative.split("?")[0]))
        : file;
      const fromRoot = path.relative(root, target);
      if (fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
        throw new Error("link leaves the repository");
      }
      if (!fs.existsSync(target)) throw new Error("target does not exist");
      if (fragment && path.extname(target) === ".md" && !anchors(target).has(decodeURIComponent(fragment))) {
        throw new Error("heading/anchor does not exist");
      }
      localLinks++;
    } catch (error) {
      errors.push(`${label}: ${href} (${error.message})`);
    }
  });
  for (const match of text.matchAll(/npm run ([\w:-]+)/g)) {
    if (!Object.hasOwn(scripts, match[1])) errors.push(`${label}: unknown npm script ${match[1]}`);
  }
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Documentation checks passed: ${files.length} Markdown files, ${localLinks} local links/anchors, and npm script references.`);
}
