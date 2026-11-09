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
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));

// Called both on the host and inside isolated runtime copies. Git metadata is
// copied into those runtimes; --no-optional-locks keeps verification read-only.
export function verifyBaseline({ installationRoot = root, baseline = lock } = {}) {
  const pi = join(installationRoot, "pi");
  const git = (...args) => {
    try {
      return execFileSync(process.env.GRAPHER_TRUSTED_GIT || "git", ["--no-optional-locks", "-C", pi, ...args], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        env: toolchainEnv(Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))),
      }).trim();
    } catch (error) {
      throw new Error(`Cannot inspect Pi checkout: ${error.stderr?.toString().trim() || error.message}. Initialize the Pi submodule and ensure Git is available.`);
    }
  };
  if (!/^[a-f0-9]{40}$/.test(baseline.forkCommit ?? "")) throw new Error("Invalid Pi baseline commit in engine/pi-lock.json");
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(baseline.packageVersion ?? "")) throw new Error("Invalid Pi package version in engine/pi-lock.json");
  const actual = git("rev-parse", "HEAD");
  if (actual !== baseline.forkCommit) throw new Error(`Pi checkout is ${actual}, expected ${baseline.forkCommit}; restore the pinned submodule before starting Grapher`);
  if (git("status", "--porcelain", "--untracked-files=normal")) {
    throw new Error("Pi checkout has tracked or untracked changes; review and remove them before starting Grapher (ignored build artifacts and model data are allowed)");
  }
  if (json(join(pi, "packages/coding-agent/package.json")).version !== baseline.packageVersion) {
    throw new Error("Pi coding-agent version does not match engine/pi-lock.json");
  }
  if (hash(join(pi, "package-lock.json")) !== baseline.packageLockSha256) throw new Error("Pi package-lock.json does not match engine/pi-lock.json");
  const data = join(installationRoot, "engine/model-data");
  const names = Object.keys(baseline.modelData ?? {}).sort();
  if (!names.length || JSON.stringify(readdirSync(data).sort()) !== JSON.stringify(names)) {
    throw new Error("Reviewed Pi model-data files do not match engine/pi-lock.json");
  }
  for (const name of names) {
    if (!/^(?:\.manifest|[a-z0-9-]+)\.json$/.test(name) || hash(join(data, name)) !== baseline.modelData[name]) {
      throw new Error(`Reviewed Pi model data differs from engine/pi-lock.json: ${name}`);
    }
  }
}

// Root npm packages are extension peers, not the source runtime. Verify their
// exact pins separately so adoption can stage a new source baseline first.
export function verifyRootPiPins({ installationRoot = root, baseline = lock } = {}) {
  const manifest = json(join(installationRoot, "package.json"));
  const npmLock = json(join(installationRoot, "package-lock.json"));
  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"]) {
    if (manifest.dependencies?.[name] !== baseline.packageVersion ||
        npmLock.packages?.[""]?.dependencies?.[name] !== baseline.packageVersion ||
        npmLock.packages?.[`node_modules/${name}`]?.version !== baseline.packageVersion) {
      throw new Error(`Root ${name} dependency must be pinned to Pi ${baseline.packageVersion} in package.json and package-lock.json`);
    }
  }
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
    } else if (action === "verify") {
      verifyRootPiPins();
    } else throw new Error(`Unknown action: ${action}`);
    console.log(`Pi baseline verified: ${lock.forkCommit}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
