import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { toolchainEnv } from "./cargo.mjs";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const source = join(root, "pi");
export const lock = JSON.parse(readFileSync(join(root, "engine/pi-lock.json"), "utf8"));
// Merger may inherit a shadow repository's GIT_DIR/GIT_WORK_TREE. Baseline
// verification must still inspect Pi; leave those variables intact for its child.
const git = (...args) => execFileSync("git", ["-C", source, ...args], {
  encoding: "utf8",
  env: toolchainEnv(Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))),
}).trim();
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

export function verifyBaseline() {
  if (git("rev-parse", "HEAD") !== lock.forkCommit) throw new Error("Pi HEAD differs from engine/pi-lock.json");
  if (git("status", "--porcelain", "--untracked-files=normal")) throw new Error("Pi source has local changes; do not build an unrecorded engine");
  git("merge-base", "--is-ancestor", lock.upstreamCommit, "HEAD");
  if (hash(join(source, "package-lock.json")) !== lock.packageLockSha256) throw new Error("Pi dependency lock mismatch");
  const data = join(root, "engine/model-data");
  if (JSON.stringify(readdirSync(data).sort()) !== JSON.stringify(Object.keys(lock.modelData).sort())) throw new Error("Model data file set mismatch");
  for (const [name, expected] of Object.entries(lock.modelData)) {
    if (hash(join(data, name)) !== expected) throw new Error(`Model data checksum mismatch: ${name}`);
  }
}

export function restoreModelData() {
  const destination = join(source, "packages/ai/src/providers/data");
  mkdirSync(destination, { recursive: true });
  // Removed providers from an older local hydration must not survive an upgrade.
  for (const name of readdirSync(destination)) {
    if (name.endsWith('.json') && !(name in lock.modelData)) rmSync(join(destination, name));
  }
  for (const name of Object.keys(lock.modelData)) copyFileSync(join(root, "engine/model-data", name), join(destination, name));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    verifyBaseline();
    const action = process.argv[2] ?? "verify";
    // npm on Windows is a .cmd shim, which execFileSync cannot launch. npm run
    // provides the actual JS CLI path; invoke it through the current Node.
    const run = (...args) => {
      const npmCli = process.env.npm_execpath;
      if (process.platform === "win32" && !npmCli) {
        throw new Error("Run Pi setup/build via npm run so npm_execpath is available");
      }
      execFileSync(npmCli ? process.execPath : "npm", npmCli ? [npmCli, ...args, "--prefix", source] : [...args, "--prefix", source], {
        stdio: "inherit", env: toolchainEnv(),
      });
    };
    if (action === "setup") {
      run("ci");
      restoreModelData();
      // Pi source imports sibling workspaces via their built dist/ exports.
      // Validating model data alone leaves a fresh installation unable to run.
      run("run", "build:offline");
    } else if (action === "build") {
      restoreModelData();
      run("run", "build:offline");
    } else if (action !== "verify") throw new Error(`Unknown action: ${action}`);
    console.log(`Pi baseline verified: ${lock.forkCommit}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
