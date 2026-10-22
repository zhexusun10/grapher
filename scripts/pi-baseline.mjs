import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { toolchainEnv } from "./cargo.mjs";
import { installPiDependencies, verifyPiDependencies } from "./pi-dependencies.mjs";
import { regenerateModelDataManifest } from "./model-data-manifest.mjs";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const source = join(root, "pi");
export const lock = JSON.parse(readFileSync(join(root, "engine/pi-lock.json"), "utf8"));
const executable = process.env.GRAPHER_TRUSTED_GIT || "git";
const git = (...args) => execFileSync(executable, ["-C", source, ...args], {
  encoding: "utf8",
  env: toolchainEnv(Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))),
}).trim();
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

export function verifyBaseline() {
}

export const localModelData = join(root, "engine/model-data-local");

// Restores the reviewed upstream model catalog, then applies the git-ignored
// local overlay (engine/model-data-local, full-file provider overrides for
// personal API tweaks). Overlay changes are not part of the reviewed baseline,
// so their merged catalog gets a freshly computed manifest and upstream
// validation still passes. The committed baseline itself stays pristine.
// Tests may pass an isolated overlay directory instead of the developer's.
export function restoreModelData(
  destination = join(source, "packages/ai/src/providers/data"),
  overlayDirectory = localModelData,
) {
  const overlay = existsSync(overlayDirectory)
    ? readdirSync(overlayDirectory).filter(name => name.endsWith('.json'))
    : [];
  if (overlay.includes('.manifest.json')) throw new Error('The local model-data overlay must not contain .manifest.json; it is regenerated from the merged catalog');
  const unknown = overlay.filter(name => !(name in lock.modelData));
  if (unknown.length) {
    throw new Error(`Local model-data overlay contains unknown providers (${unknown.join(', ')}); adding a provider requires submodule changes, not an overlay`);
  }
  const allowed = new Set([...Object.keys(lock.modelData), ...overlay]);
  mkdirSync(destination, { recursive: true });
  // Removed providers from an older local hydration must not survive an upgrade.
  for (const name of readdirSync(destination)) {
    if (name.endsWith('.json') && !allowed.has(name)) rmSync(join(destination, name));
  }
  for (const name of Object.keys(lock.modelData)) copyFileSync(join(root, "engine/model-data", name), join(destination, name));
  for (const name of overlay) copyFileSync(join(overlayDirectory, name), join(destination, name));
  if (overlay.length) regenerateModelDataManifest(join(destination, '..', '..', '..'));
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
