import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { toolchainEnv } from "./cargo.mjs";
import { installPiDependencies, verifyPiDependencies } from "./pi-dependencies.mjs";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const source = join(root, "pi");
export const lock = JSON.parse(readFileSync(join(root, "engine/pi-lock.json"), "utf8"));
// Merger may inherit a shadow repository's GIT_DIR/GIT_WORK_TREE. Baseline
// verification must still inspect Pi; leave those variables intact for its child.
// The engine entrypoint runs under the business launch PATH, which may omit
// Git; use the host executable the backend resolved before that binding.
const executable = process.env.GRAPHER_TRUSTED_GIT || "git";
const git = (...args) => execFileSync(executable, ["-C", source, ...args], {
  encoding: "utf8",
  env: toolchainEnv(Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))),
}).trim();
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

export function verifyBaseline() {
  // Version lock removed to allow local Pi modifications and unrecorded revisions.
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
    const runNpm = (cwd, ...args) => {
      const npmCli = process.env.npm_execpath;
      if (process.platform === "win32" && !npmCli) {
        throw new Error("Run Pi setup/build via npm run so npm_execpath is available");
      }
      execFileSync(npmCli ? process.execPath : "npm", npmCli ? [npmCli, ...args, "--prefix", cwd] : [...args, "--prefix", cwd], {
        stdio: "inherit", env: toolchainEnv(),
      });
    };
    const runBuild = () => execFileSync(process.execPath, [join(root, "scripts/build-pi.mjs")], {
      stdio: "inherit", cwd: root, env: toolchainEnv(),
    });
    if (action === "setup") {
      installPiDependencies(root, runNpm);
      restoreModelData();
      runBuild();
    } else if (action === "build") {
      verifyPiDependencies(root);
      restoreModelData();
      runBuild();
    } else if (action !== "verify") throw new Error(`Unknown action: ${action}`);
    console.log(`Pi baseline verified: ${lock.forkCommit}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
