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

test("checker syntax is valid", () => {
  execFileSync(process.execPath, ["--check", checker]);
});
