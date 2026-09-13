import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { join } from "node:path";
import { lock, root, verifyBaseline } from "./pi-baseline.mjs";

test("Pi source, dependency lock and model data match the recorded baseline", () => {
  assert.doesNotThrow(verifyBaseline);
  const entry = execFileSync("git", ["ls-files", "--stage", "pi"], { cwd: root, encoding: "utf8" });
  assert.match(entry, new RegExp(`^160000 ${lock.forkCommit} 0\\tpi`));
});

test("owned entrypoint starts the pinned CLI without a global Pi executable", () => {
  const version = execFileSync(process.execPath, [join(root, "engine/entrypoint.mjs"), "--version"], {
    cwd: root, encoding: "utf8", timeout: 30000,
  });
  assert.equal(version.trim(), lock.packageVersion);
});
