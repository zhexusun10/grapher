import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "../pi/node_modules/esbuild/lib/main.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

await mkdir(path.resolve(".grapher"), { recursive: true });
const root = await mkdtemp(path.resolve(".grapher/publication-ui-"));
try {
  await build({ entryPoints: ["src/components/PublicationPanel.tsx"], bundle: true,
    platform: "node", format: "esm", packages: "external", jsx: "automatic", loader: { ".css": "empty" },
    external: ["react", "react-dom", "react/jsx-runtime"], outfile: path.join(root, "panel.mjs") });
  const { PublicationPanel } = await import(pathToFileURL(path.join(root, "panel.mjs")));
  const base = { repository: "/user/project", heads: ["a", "b"], status: "publishing", head: null, error: null, startedAt: 1, completedAt: null };
  const render = (status, extra = {}, mergers = []) => renderToStaticMarkup(createElement(PublicationPanel, {
    publication: { ...base, status, ...extra }, mergers, busy: false, onRetry() {},
  }));
  test("publishing and merging show progress without claiming files have landed", () => {
    for (const status of ["publishing", "merging"]) {
      const html = render(status);
      assert.match(html, /正在/);
      assert.match(html, /\/user\/project/);
      assert.doesNotMatch(html, /已写回工作文件夹|重试回写/);
    }
  });
  test("failed publication exposes error and retry; success exposes committed result", () => {
    const failed = render("failed", { error: "Local changes need attention" });
    assert.match(failed, /Local changes need attention/);
    assert.match(failed, /重试回写/);
    assert.doesNotMatch(failed, /已写回工作文件夹/);
    const success = render("completed", { head: "final-commit", completedAt: 1234 });
    assert.match(success, /已写回工作文件夹/);
    assert.match(success, /final-commit/);
    assert.doesNotMatch(success, /重试回写/);
  });
  test("merger has independent execution history, status, directory and session", () => {
    const html = render("merging", {}, [{ id: "m-1", node: "merger", revision: 1, attempt: 1,
      sessionId: "session-merger", worktree: "/user/project", before: "before-commit", after: null,
      status: "running", output: "live output", startedAt: 1, completedAt: null }]);
    assert.match(html, /merger · Execution Instance/);
    assert.match(html, /session-merger/);
    assert.match(html, /before-commit/);
    assert.match(html, /执行中/);
  });
} finally {
  await rm(root, { recursive: true, force: true });
}
