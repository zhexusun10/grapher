import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { enableCompileCache, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extname, join, resolve, sep } from "node:path";
import { toolchainEnv } from "./cargo.mjs";
import { corePackages, installPiDependencies, verifyPiDependencies } from "./pi-dependencies.mjs";
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

function matchTsconfigAlias(alias, specifier) {
  if (!alias.pattern.includes("*")) return specifier === alias.pattern ? "" : undefined;
  if (!specifier.startsWith(alias.prefix) || !specifier.endsWith(alias.suffix)) return undefined;
  return specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length);
}

function resolvePiSourcePath(piRoot, replacement) {
  const basePath = resolve(piRoot, replacement);
  const rootPrefix = piRoot.endsWith(sep) ? piRoot : `${piRoot}${sep}`;
  if (!basePath.startsWith(rootPrefix)) return undefined;
  const extension = extname(basePath);
  const sourceExtension =
    extension === ".js" ? ".ts" : extension === ".mjs" ? ".mts" : extension === ".cjs" ? ".cts" : undefined;
  const candidates = sourceExtension
    ? [basePath, `${basePath.slice(0, -extension.length)}${sourceExtension}`]
    : extension === ".ts" || extension === ".mts" || extension === ".cts" || extension === ".json"
      ? [basePath]
      : [basePath, `${basePath}.ts`, resolve(basePath, "index.ts")];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

let activeResolverState = null;

// Register a cached Pi workspace source resolver and enable V8's compile cache.
// Pi's extension loader relies on `import.meta.url` ending in `.ts` to enable
// source-runtime `jiti` resolution (avoiding dist alias collisions and dual
// module instances), so workspace aliases always resolve to `pi/packages/*/src`.
export function installPiRuntimeResolver({ installationRoot = root } = {}) {
  try { enableCompileCache(); } catch {}
  if (activeResolverState?.key === installationRoot) return;
  const piRoot = join(installationRoot, "pi");
  const tsconfigPath = resolve(piRoot, "tsconfig.json");
  let aliases = [];
  try {
    const tsconfig = json(tsconfigPath);
    const paths = tsconfig.compilerOptions?.paths;
    if (!paths) return;
    aliases = Object.entries(paths)
      .filter(([pattern]) => pattern.startsWith("@earendil-works/"))
      .map(([pattern, replacements]) => {
        const wildcard = pattern.indexOf("*");
        if (wildcard !== -1 && pattern.indexOf("*", wildcard + 1) !== -1) {
          throw new Error(`Source runtime does not support multiple wildcards in ${pattern}`);
        }
        return {
          pattern,
          prefix: wildcard === -1 ? pattern : pattern.slice(0, wildcard),
          suffix: wildcard === -1 ? "" : pattern.slice(wildcard + 1),
          replacements,
        };
      })
      .sort((left, right) => right.pattern.length - left.pattern.length);
  } catch {
    return;
  }
  const state = {
    key: installationRoot,
    piRoot,
    aliases,
    aliasCache: new Map(),
  };
  const shouldRegister = !activeResolverState;
  activeResolverState = state;
  if (!shouldRegister) return;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const current = activeResolverState;
      if (!current) return nextResolve(specifier, context);
      if (specifier.startsWith("@earendil-works/")) {
        const cached = current.aliasCache.get(specifier);
        if (cached !== undefined) return { url: cached, shortCircuit: true };
        let matchedPattern;
        for (const alias of current.aliases) {
          const wildcard = matchTsconfigAlias(alias, specifier);
          if (wildcard === undefined) continue;
          matchedPattern ??= alias.pattern;
          for (const replacement of alias.replacements) {
            const target = replacement.replace("*", wildcard);
            const resolved = resolvePiSourcePath(current.piRoot, target);
            if (resolved) {
              const url = pathToFileURL(resolved).href;
              current.aliasCache.set(specifier, url);
              return { url, shortCircuit: true };
            }
          }
        }
        if (matchedPattern) {
          throw new Error(`Source runtime could not resolve ${specifier} through tsconfig path ${matchedPattern}`);
        }
      }
      return nextResolve(specifier, context);
    },
  });
}

function resolvePiGitDir(piDir) {
  const dotGit = join(piDir, ".git");
  const st = statSync(dotGit);
  if (st.isDirectory()) return dotGit;
  const content = readFileSync(dotGit, "utf8").trim();
  const match = /^gitdir:\s*(.+)$/i.exec(content);
  return match ? resolve(piDir, match[1]) : null;
}

function fastBaselineFingerprint(installationRoot = root, baseline = lock) {
  try {
    if (!/^[a-f0-9]{40}$/.test(baseline.forkCommit ?? "")) return null;
    if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(baseline.packageVersion ?? "")) return null;
    const piDir = join(installationRoot, "pi");
    const gitDir = resolvePiGitDir(piDir);
    if (!gitDir) return null;
    const headRaw = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    let headCommit = headRaw;
    if (headRaw.startsWith("ref:")) {
      const ref = headRaw.slice(4).trim();
      const refPath = join(gitDir, ref);
      if (existsSync(refPath)) {
        headCommit = readFileSync(refPath, "utf8").trim();
      } else {
        const packed = join(gitDir, "packed-refs");
        if (!existsSync(packed)) return null;
        const st = statSync(packed);
        headCommit = `${headRaw}:${st.size}:${st.mtimeMs}`;
      }
    }
    if (/^[a-f0-9]{40}$/.test(headCommit) && headCommit !== baseline.forkCommit) return null;
    const indexStat = statSync(join(gitDir, "index"));
    if (json(join(piDir, "packages/coding-agent/package.json")).version !== baseline.packageVersion) return null;
    const piPkgStat = statSync(join(piDir, "package.json"));
    const piLockStat = statSync(join(piDir, "package-lock.json"));
    const modulesStat = statSync(join(piDir, "node_modules"));
    const depMarker = readFileSync(join(piDir, "node_modules/.grapher-pi-dependencies.json"), "utf8").trim();
    const depPkgStat = statSync(join(installationRoot, "engine/pi-dependencies/package.json"));
    const depLockStat = statSync(join(installationRoot, "engine/pi-dependencies/package-lock.json"));
    const modelDataDir = join(installationRoot, "engine/model-data");
    const expectedModelFiles = Object.keys(baseline.modelData ?? {}).sort();
    const actualModelFiles = readdirSync(modelDataDir).sort();
    if (!expectedModelFiles.length || JSON.stringify(actualModelFiles) !== JSON.stringify(expectedModelFiles)) return null;

    const digest = createHash("sha256");
    digest.update(`${installationRoot}\0${baseline.forkCommit}\0${baseline.packageVersion}\0${baseline.packageLockSha256}\0`);
    digest.update(`${headCommit}\0${indexStat.size}:${indexStat.mtimeMs}:${indexStat.ctimeMs}\0`);
    digest.update(`${piPkgStat.size}:${piPkgStat.mtimeMs}\0${piLockStat.size}:${piLockStat.mtimeMs}\0${modulesStat.mtimeMs}\0`);
    digest.update(`${depMarker}\0`);
    digest.update(`${depPkgStat.size}:${depPkgStat.mtimeMs}\0${depLockStat.size}:${depLockStat.mtimeMs}\0`);
    for (const pkgName of corePackages) {
      const st = statSync(join(piDir, "packages", pkgName, "package.json"));
      digest.update(`pkg:${pkgName}:${st.size}:${st.mtimeMs}\0`);
    }
    for (const name of actualModelFiles) {
      const st = statSync(join(modelDataDir, name));
      digest.update(`md:${name}:${st.size}:${st.mtimeMs}\0`);
    }
    const overlayDir = join(installationRoot, "engine/model-data-local");
    if (existsSync(overlayDir)) {
      for (const name of readdirSync(overlayDir).filter(file => file.endsWith(".json")).sort()) {
        const st = statSync(join(overlayDir, name));
        digest.update(`local:${name}:${st.size}:${st.mtimeMs}\0`);
      }
    }
    return digest.digest("hex");
  } catch {
    return null;
  }
}

const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = ms => { try { Atomics.wait(waitBuffer, 0, 0, ms); } catch {} };

// Verify baseline and Pi dependencies once per explicit backend lifecycle
// context (`GRAPHER_BASELINE_CONTEXT`), reusing the verified stamp across
// Provider/Auth, Partitioner, Planner, and NodeAgent prewarm workers while
// installing the cached source-runtime resolver. Standalone CLI runs without an
// explicit backend context always perform full verification.
export function verifyRuntimeBaseline({ installationRoot = root, baseline = lock } = {}) {
  const contextKey = process.env.GRAPHER_BASELINE_CONTEXT?.trim();
  const fingerprint = contextKey ? fastBaselineFingerprint(installationRoot, baseline) : null;
  if (!contextKey || !fingerprint) {
    verifyBaseline({ installationRoot, baseline });
    verifyPiDependencies(installationRoot, { installationRoot });
    installPiRuntimeResolver({ installationRoot });
    return { verified: true, cached: false };
  }
  const verifiedEnvValue = `${contextKey}:${fingerprint}`;
  if (process.env.GRAPHER_VERIFIED_BASELINE === verifiedEnvValue) {
    installPiRuntimeResolver({ installationRoot });
    return { verified: true, cached: true };
  }

  const cacheDir = join(tmpdir(), "grapher-pi-baseline-cache");
  const stampKey = createHash("sha256")
    .update(`v2\0${contextKey}\0${installationRoot}\0${fingerprint}`)
    .digest("hex");
  const stampFile = join(cacheDir, `${stampKey}.json`);
  const lockFile = join(cacheDir, `${stampKey}.lock`);

  const readStamp = () => {
    try {
      const parsed = json(stampFile);
      if (parsed && parsed.verified === true) {
        process.env.GRAPHER_VERIFIED_BASELINE = verifiedEnvValue;
        installPiRuntimeResolver({ installationRoot });
        return { verified: true, cached: true };
      }
    } catch {}
    return null;
  };

  const hit = readStamp();
  if (hit) return hit;

  let lockFd;
  try {
    mkdirSync(cacheDir, { recursive: true });
    lockFd = openSync(lockFile, "wx");
  } catch (error) {
    if (error?.code === "EEXIST") {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const afterWait = readStamp();
        if (afterWait) return afterWait;
        try {
          const st = statSync(lockFile);
          if (Date.now() - st.mtimeMs > 10000) break;
        } catch {
          break;
        }
        sleepSync(5);
      }
      const afterLock = readStamp();
      if (afterLock) return afterLock;
    }
  }

  try {
    verifyBaseline({ installationRoot, baseline });
    verifyPiDependencies(installationRoot, { installationRoot });
    try {
      mkdirSync(cacheDir, { recursive: true });
      const tempStamp = `${stampFile}.${process.pid}.tmp`;
      writeFileSync(tempStamp, `${JSON.stringify({ verified: true, timestamp: Date.now() })}\n`);
      renameSync(tempStamp, stampFile);
      const now = Date.now();
      for (const name of readdirSync(cacheDir)) {
        if (name === `${stampKey}.json` || name === `${stampKey}.lock`) continue;
        try {
          const candidate = join(cacheDir, name);
          if (now - statSync(candidate).mtimeMs > 600000) rmSync(candidate, { force: true });
        } catch {}
      }
    } catch {}
    process.env.GRAPHER_VERIFIED_BASELINE = verifiedEnvValue;
    installPiRuntimeResolver({ installationRoot });
    return { verified: true, cached: false };
  } finally {
    if (lockFd !== undefined) {
      try { closeSync(lockFd); } catch {}
      try { rmSync(lockFile, { force: true }); } catch {}
    }
  }
}

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
