import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const checker = fileURLToPath(new URL("./check-docs.mjs", import.meta.url));
function fixture(t, files, scripts = { "check:docs": "node scripts/check-docs.mjs" }) {
  const root = mkdtempSync(join(tmpdir(), "grapher-docs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts }));
  for (const [name, content] of Object.entries(files)) {
    const target = join(root, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}
function run(root) {
  return spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
}

test("validates relative links, images, formatted/Unicode headings, and duplicate anchors", (t) => {
  const root = fixture(t, {
    "README.md": "# Home\n[Guide](docs/guide.md#hello-world)\n[中文](docs/guide.md#执行模型)\n[Again](docs/guide.md#hello-world-1)\n![Demo](assets/demo.svg)\n`npm run check:docs`\n",
    "docs/guide.md": "# **Hello** `world`\n## 执行模型\n## Hello world\n[Back](../README.md#home)\n",
    "assets/demo.svg": "<svg/>",
  });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /5 local links\/anchors/);
});

test("rejects missing document targets", (t) => {
  const result = run(fixture(t, { "README.md": "[Missing](docs/missing.md)" }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /README\.md: docs\/missing\.md \(target does not exist\)/);
});

test("rejects stale anchors even when the file exists", (t) => {
  const result = run(fixture(t, { "README.md": "# Current\n[Stale](#previous)" }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /heading\/anchor does not exist/);
});

test("rejects npm commands that are not package scripts", (t) => {
  const result = run(fixture(t, { "README.md": "```sh\nnpm run obsolete\n```" }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown npm script obsolete/);
});

test("skips upstream, dependencies, build outputs, runtime history, and external URLs", (t) => {
  const root = fixture(t, {
    "README.md": "# Home\n[External](https://example.invalid/not-fetched)\n",
    "pi/README.md": "[Broken](absent.md)",
    "node_modules/package/README.md": "[Broken](absent.md)",
    ".grapher/history.md": "[Broken](absent.md)",
    ".grapher-verify-demo/history.md": "[Broken](absent.md)",
    "backend/target/generated.md": "[Broken](absent.md)",
  });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 Markdown files, 0 local links/);
});

test("accepts explicit HTML anchors and rejects repository escapes", (t) => {
  const root = fixture(t, {
    "README.md": '<a id="custom"></a>\n[Custom](#custom)\n[Outside](../outside.md)\n',
  });
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /link leaves the repository/);
  assert.doesNotMatch(result.stderr, /#custom/);
});

function navigation(current = [], historical = [], routes = []) {
  const links = entries => entries.map(href => `- [Page](${href})`).join("\n");
  return `# Docs\n\n## Task routes\n\n${links(routes)}\n\n## Current documentation\n\n${links(current)}\n\n## Proposals and historical evidence\n\n${links(historical)}\n`;
}

test("index covers distributed knowledge and related implementation links", (t) => {
  const root = fixture(t, {
    "docs/index.md": navigation(["guide.md", "../README.md", "../AGENTS.md", "../engine/README.md"]),
    "README.md": "# Home\n[Index](docs/index.md)",
    "AGENTS.md": "# Agent guide\n[Docs](docs/index.md)",
    "engine/README.md": "# Engine\n[Guide](../docs/guide.md)",
    "docs/guide.md": "# Guide\n\n> **Status:** active\n> **Maintained with:** [runtime](../backend/src/runtime.rs)\n",
    "backend/src/runtime.rs": "// Implementation",
  });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /index coverage, document status and current\/historical routing/);
});

test("rejects unindexed knowledge even when another page links to it", (t) => {
  const root = fixture(t, {
    "docs/index.md": navigation(["guide.md"]),
    "docs/guide.md": "# Guide\n[Design](../engine/design.md)\n[Rules](../backend/AGENTS.md)",
    "engine/design.md": "# Design",
    "backend/AGENTS.md": "# Backend guide",
  });
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /engine\/design\.md: knowledge page is not linked from docs\/index\.md/);
  assert.match(result.stderr, /backend\/AGENTS\.md: knowledge page is not linked/);
});

test("images do not satisfy knowledge-page index coverage", (t) => {
  const root = fixture(t, {
    "docs/index.md": navigation() + "\n![Not navigation](guide.md)\n",
    "docs/guide.md": "# Guide",
  });
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/guide\.md: knowledge page is not linked/);
});

test("exempts executable prompts and GitHub templates from coverage, not link checks", (t) => {
  const root = fixture(t, {
    "docs/index.md": navigation(),
    "backend/resources/prompts/planner.md": "# Planner\n[Compiler](../../src/compiler.rs)",
    "backend/src/compiler.rs": "// Compiler",
    ".github/ISSUE_TEMPLATE/bug_report.md": "# Report",
    ".github/pull_request_template.md": "# Pull request",
    "pi/README.md": "[Ignored](missing.md)",
  });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(join(root, "backend/resources/prompts/planner.md"), "[Missing](missing.md)");
  const broken = run(root);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /backend\/resources\/prompts\/planner\.md: missing\.md \(target does not exist\)/);
  assert.doesNotMatch(broken.stderr, /knowledge page is not linked/);
});

const nonCurrentPages = [
  ["proposals/idea.md", "draft", "# Idea\n> 中文方案讨论稿，尚未实现。"],
  ["reviews/audit.md", "archived", "# Audit\n> 历史快照，不是当前执行合同。"],
  ["releases/old.md", "archived", "# Old release"],
  ["archive/design.md", "archived", "# Old design"],
  ["../.github/releases/old.md", "archived", "# Announcement"],
  ["old.md", "deprecated", "# Old guide\n\n> **Status:** deprecated\n"],
];
for (const section of ["Task routes", "Current documentation"]) {
  test(`rejects non-current recommendations in ${section}`, (t) => {
    const hrefs = nonCurrentPages.map(([href]) => href);
    const files = {
      "docs/index.md": section === "Task routes" ? navigation([], [], hrefs) : navigation(hrefs),
    };
    for (const [href, , content] of nonCurrentPages) {
      files[href.startsWith("../") ? href.slice(3) : `docs/${href}`] = content;
    }
    const result = run(fixture(t, files));
    assert.equal(result.status, 1);
    for (const [href, status] of nonCurrentPages) {
      assert.ok(result.stderr.includes(`${href} (${status} page recommended as current documentation)`), result.stderr);
    }
    assert.doesNotMatch(result.stderr, /knowledge page is not linked/);
  });
}

test("accepts historical links with replacements and existing Chinese warning banners", (t) => {
  const files = {
    "docs/index.md": navigation(["guide.md"], nonCurrentPages.map(([href]) => href)),
    "docs/guide.md": "# Current guide\n\n> **Status:** active\n",
  };
  for (const [href, , content] of nonCurrentPages) {
    files[href.startsWith("../") ? href.slice(3) : `docs/${href}`] = `${content}\n\n[Current](guide.md)\n`;
  }
  // Replacement paths differ for docs/<category> and .github/releases.
  files["docs/proposals/idea.md"] = "# Idea\n> 中文方案讨论稿，尚未实现。\n\n[Current](../guide.md)";
  files["docs/reviews/audit.md"] = "# Audit\n> 历史快照，不是当前执行合同。\n\n[Current](../guide.md)";
  files["docs/releases/old.md"] = "# Old release\n[Current](../guide.md)";
  files["docs/archive/design.md"] = "# Old design\n[Current](../guide.md)";
  files[".github/releases/old.md"] = "# Announcement\n[Current](../../docs/guide.md)";
  const result = run(fixture(t, files));
  assert.equal(result.status, 0, result.stderr);
});

test("rejects explicit statuses that contradict proposal or historical directories", (t) => {
  const files = { "docs/index.md": navigation([], nonCurrentPages.slice(0, 5).map(([href]) => href)) };
  for (const [href] of nonCurrentPages.slice(0, 5)) {
    files[href.startsWith("../") ? href.slice(3) : `docs/${href}`] = "# Page\n\n> **Status:** active\n";
  }
  const result = run(fixture(t, files));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /status active conflicts with directory role draft/);
  assert.equal((result.stderr.match(/status active conflicts with directory role archived/g) ?? []).length, 4);
});

test("rejects unknown status values in a visible page header", (t) => {
  const result = run(fixture(t, {
    "docs/index.md": navigation(["guide.md"]),
    "docs/guide.md": "# Guide\n\n> **Status:** current\n",
  }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown document status current/);
});

test("does not interpret code examples or later quotations as page metadata", (t) => {
  const result = run(fixture(t, {
    "docs/index.md": navigation(["guide.md", "example.md"]),
    "docs/guide.md": "# Guide\n\n> **Status:** active\n\n```markdown\n> **Status:** draft\n```\n\n> **Status:** archived\n",
    "docs/example.md": "# Example\n\n```markdown\n> **Status:** invalid\n```\n\n> **Status:** draft\n",
  }));
  assert.equal(result.status, 0, result.stderr);
});

test("checks related implementation links in visible metadata", (t) => {
  const result = run(fixture(t, {
    "docs/index.md": navigation(["guide.md"]),
    "docs/guide.md": "# Guide\n\n> **Status:** active\n> **Maintained with:** [Missing](../backend/src/removed.rs)\n",
  }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /removed\.rs \(target does not exist\)/);
});

test("requires routing headings so renaming one cannot silently disable status checks", (t) => {
  const result = run(fixture(t, {
    "docs/index.md": navigation().replace("## Task routes", "## Tasks"),
  }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing routing section Task routes/);
});

test("rejects directory-only repository escapes", (t) => {
  const result = run(fixture(t, { "README.md": "[Outside](../)" }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /link leaves the repository/);
});

test("checker syntax is valid", () => {
  execFileSync(process.execPath, ["--check", checker]);
});
