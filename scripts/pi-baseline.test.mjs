import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { join } from "node:path";
import { lock, root, verifyBaseline } from "./pi-baseline.mjs";
import { toolchainEnv } from "./cargo.mjs";

test("Pi source, dependency lock and model data match the recorded baseline", () => {
  assert.doesNotThrow(verifyBaseline);
  const entry = execFileSync("git", ["ls-files", "--stage", "pi"], { cwd: root, encoding: "utf8", env: toolchainEnv() });
  assert.match(entry, new RegExp(`^160000 ${lock.forkCommit} 0\\tpi`));
});

test("owned entrypoint starts the pinned CLI without a global Pi executable", () => {
  const version = execFileSync(process.execPath, [join(root, "engine/entrypoint.mjs"), "--version"], {
    cwd: root, encoding: "utf8", timeout: 30000,
    // Merger's shadow Git environment must not redirect baseline verification.
    env: toolchainEnv({ ...process.env, GIT_DIR: join(root, ".grapher/nonexistent-test-git-dir"), GIT_WORK_TREE: root }),
  });
  assert.equal(version.trim(), lock.packageVersion);
});

test("engine prompt adapter system prompt passes syntax validation", () => {
  execFileSync(process.execPath, ["--check", join(root, "engine/system-prompt.mjs")], {
    cwd: root, encoding: "utf8", env: toolchainEnv(),
  });
});

test("worker extension engine/prompt-extension.ts loads cleanly without syntax or import errors", () => {
  execFileSync(process.execPath, [
    join(root, "pi/node_modules/tsx/dist/cli.mjs"),
    "-e",
    "import('./engine/prompt-extension.ts').catch(e => { console.error(e); process.exit(1); })",
  ], {
    cwd: root, encoding: "utf8", timeout: 20000, env: toolchainEnv(),
  });
});
