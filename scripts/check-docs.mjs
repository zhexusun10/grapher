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
const documentTokens = new Map();
const documentLinks = new Map();
const documentStatuses = new Map();
const statuses = new Set(["active", "draft", "deprecated", "archived"]);
const currentSections = new Set(["Task routes", "Current documentation"]);
const historicalSection = "Proposals and historical evidence";
let localLinks = 0;
function labelFor(file) {
  return path.relative(root, file).split(path.sep).join("/");
}
function directoryStatus(label) {
  if (label.startsWith("docs/proposals/")) return "draft";
  if (["docs/reviews/", "docs/releases/", "docs/archive/", ".github/releases/"]
    .some(prefix => label.startsWith(prefix))) return "archived";
}
function isKnowledgePage(file) {
  const label = labelFor(file);
  return !label.startsWith("backend/resources/prompts/")
    && !label.startsWith(".github/ISSUE_TEMPLATE/")
    && label !== ".github/pull_request_template.md";
}
function localTarget(file, href) {
  if (/^[a-z][\w+.-]*:/i.test(href) || href.startsWith("//")) return;
  const [relative, fragment] = href.split("#");
  const target = relative
    ? path.resolve(path.dirname(file), decodeURIComponent(relative.split("?")[0]))
    : file;
  const fromRoot = path.relative(root, target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    throw new Error("link leaves the repository");
  }
  return { target, fragment };
}
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
  const label = labelFor(file);
  const text = fs.readFileSync(file, "utf8");
  const tokens = marked.lexer(text);
  documentTokens.set(file, tokens);
  const links = new Set();
  documentLinks.set(file, links);
  // Only a visible header immediately after the H1 is metadata. Code examples
  // and later quoted documents must not change the page's status.
  const opening = tokens.filter(token => token.type !== "space").slice(0, 2);
  const header = opening[0]?.type === "heading" && opening[0].depth === 1
    && opening[1]?.type === "blockquote" ? opening[1].text : "";
  const status = header.match(/^\*\*Status:\*\*[ \t]*(\S+)/)?.[1];
  const expected = directoryStatus(label);
  if (status && !statuses.has(status)) errors.push(`${label}: unknown document status ${status}`);
  if (status && expected && status !== expected) {
    errors.push(`${label}: status ${status} conflicts with directory role ${expected}`);
  }
  documentStatuses.set(file, status ?? expected ?? "active");
  marked.walkTokens(tokens, (token) => {
    if (!["link", "image"].includes(token.type)) return;
    const href = token.href;
    try {
      const resolved = localTarget(file, href);
      if (!resolved) return;
      const { target, fragment } = resolved;
      if (!fs.existsSync(target)) throw new Error("target does not exist");
      if (fragment && path.extname(target) === ".md" && !anchors(target).has(decodeURIComponent(fragment))) {
        throw new Error("heading/anchor does not exist");
      }
      if (token.type === "link" && path.extname(target) === ".md") links.add(target);
      localLinks++;
    } catch (error) {
      errors.push(`${label}: ${href} (${error.message})`);
    }
  });
  for (const match of text.matchAll(/npm run ([\w:-]+)/g)) {
    if (!Object.hasOwn(scripts, match[1])) errors.push(`${label}: unknown npm script ${match[1]}`);
  }
}
// The index opts a repository into knowledge coverage. Legacy/generic fixtures
// without an index still exercise the independent link/command checks above.
const index = path.join(root, "docs", "index.md");
const hasIndex = documentTokens.has(index);
if (hasIndex) {
  const indexed = documentLinks.get(index);
  const headings = documentTokens.get(index)
    .filter(token => token.type === "heading" && token.depth === 2)
    .map(token => plainText(token.tokens ?? []));
  for (const section of [...currentSections, historicalSection]) {
    if (!headings.includes(section)) {
      errors.push(`docs/index.md: missing routing section ${section}`);
    }
  }
  for (const file of files) {
    if (file !== index && isKnowledgePage(file) && !indexed.has(file)) {
      errors.push(`${labelFor(file)}: knowledge page is not linked from docs/index.md`);
    }
  }
  let currentSection = false;
  for (const token of documentTokens.get(index)) {
    if (token.type === "heading" && token.depth <= 2) {
      currentSection = token.depth === 2 && currentSections.has(plainText(token.tokens ?? []));
    }
    if (!currentSection) continue;
    marked.walkTokens([token], (child) => {
      if (child.type !== "link") return;
      try {
        const resolved = localTarget(index, child.href);
        if (!resolved || path.extname(resolved.target) !== ".md") return;
        const status = documentStatuses.get(resolved.target);
        if (status && status !== "active") {
          errors.push(`docs/index.md: ${child.href} (${status} page recommended as current documentation)`);
        }
      } catch {
        // Invalid links already have a precise diagnostic from the link pass.
      }
    });
  }
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  const navigation = hasIndex ? ", index coverage, document status and current/historical routing" : "";
  console.log(`Documentation checks passed: ${files.length} Markdown files, ${localLinks} local links/anchors, npm script references${navigation}.`);
}
