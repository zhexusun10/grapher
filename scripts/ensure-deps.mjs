import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { missingBundledExtensions } from "./bundled-extensions.mjs";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const piSource = join(root, "pi");
export const viteBin = join(root, "node_modules", "vite", "bin", "vite.js");
export const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
export const piPackageJson = join(piSource, "package.json");
export const piDependencyMarker = join(piSource, "node_modules", ".grapher-pi-dependencies.json");
export const piDist = join(piSource, "packages", "ai", "dist");

/**
 * Fast synchronous check for Cargo installation (< 0.1ms).
 */
export function findCargoExecutable() {
  if (process.env.CARGO && existsSync(process.env.CARGO)) {
    return process.env.CARGO;
  }
  const cargoName = process.platform === "win32" ? "cargo.exe" : "cargo";
  const rustupCargo = join(homedir(), ".cargo", "bin", cargoName);
  if (existsSync(rustupCargo)) {
    return rustupCargo;
  }
  const paths = (process.env.PATH ?? "").split(delimiter);
  for (const dir of paths) {
    if (!dir) continue;
    const candidate = join(dir, cargoName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function rootDependenciesReady(installationRoot = root) {
  return existsSync(join(installationRoot, "node_modules/vite/bin/vite.js")) &&
    existsSync(join(installationRoot, "node_modules/tsx/dist/cli.mjs")) &&
    missingBundledExtensions(installationRoot).length === 0;
}

/**
 * Synchronous filesystem check with zero subprocess overhead.
 */
export function checkDependenciesFast() {
  const missingSubmodule = !existsSync(piPackageJson);
  const missingRootModules = !rootDependenciesReady();
  const missingPiDist = !existsSync(piDist);
  const missingPiDependencies = !existsSync(piDependencyMarker);
  const cargoPath = findCargoExecutable();
  const missingCargo = !cargoPath;

  return {
    missingSubmodule,
    missingRootModules,
    missingPiDist,
    missingPiDependencies,
    missingCargo,
    cargoPath,
    allReady: !missingSubmodule && !missingRootModules && !missingPiDist && !missingPiDependencies && !missingCargo,
  };
}

/**
 * Cross-platform npm execution.
 */
function runNpm(args, options = {}) {
  const npmCli = process.env.npm_execpath;
  if (npmCli && existsSync(npmCli)) {
    execFileSync(process.execPath, [npmCli, ...args], { stdio: "inherit", ...options });
  } else if (process.platform === "win32") {
    execFileSync("npm.cmd", args, { stdio: "inherit", ...options });
  } else {
    execFileSync("npm", args, { stdio: "inherit", ...options });
  }
}

/**
 * Ensure all dependencies are ready.
 * If dependencies are already satisfied, returns in < 2ms.
 * If any are missing, automatically fetches and installs them in order.
 */
export async function ensureDependencies() {
  const status = checkDependenciesFast();

  // Fast path when all dependencies are ready: zero subprocesses, < 2ms
  if (status.allReady) {
    return;
  }

  console.log("\n[dev] Checking and installing missing dependencies...");

  // 1. Check and initialize Git submodule (pi)
  if (status.missingSubmodule) {
    console.log("[dev] [1/3] Pi engine submodule not found. Running git submodule update --init --recursive...");
    try {
      execFileSync("git", ["submodule", "update", "--init", "--recursive"], {
        stdio: "inherit",
        cwd: root,
      });
      console.log("[dev] [1/3] Pi engine submodule initialized.");
    } catch (error) {
      console.error("[dev] ❌ Failed to update git submodule:", error.message);
      throw error;
    }
  }

  // 2. Check root dependencies, including the bundled runtime extensions.
  if (status.missingRootModules) {
    console.log("[dev] [2/3] Root dependencies are missing or outdated. Running npm ci --ignore-scripts...");
    try {
      runNpm(["ci", "--ignore-scripts"], { cwd: root });
    } catch (err) {
      console.warn("[dev] npm ci failed, falling back to npm install --ignore-scripts...");
      runNpm(["install", "--ignore-scripts"], { cwd: root });
    }
    console.log("[dev] [2/3] Root dependencies installed.");
  }

  // 3. Check and initialize Pi engine dependencies and offline build
  if (status.missingPiDist || status.missingPiDependencies) {
    console.log("[dev] [3/3] Pi engine build artifacts not found. Running npm run pi:setup...");
    try {
      const piBaselineScript = join(root, "scripts", "pi-baseline.mjs");
      execFileSync(process.execPath, [piBaselineScript, "setup"], {
        stdio: "inherit",
        cwd: root,
        env: { ...process.env, npm_execpath: process.env.npm_execpath },
      });
      console.log("[dev] [3/3] Pi engine dependencies and build complete.");
    } catch (error) {
      console.error("[dev] ❌ Failed to initialize Pi engine:", error.message);
      throw error;
    }
  }

  // 4. Rust / Cargo environment check and guidance
  if (status.missingCargo) {
    console.error("\n" + "=".repeat(70));
    console.error("[dev] ❌ Rust/Cargo toolchain not found!");
    console.error("[dev] The backend service is written in Rust; Cargo is required to build and run Grapher.");
    console.error("[dev] Please install Rust:");
    if (process.platform === "win32") {
      console.error("[dev]   👉 Windows: visit https://rustup.rs/ to download and install rustup-init.exe");
    } else {
      console.error("[dev]   👉 Run in terminal: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh");
    }
    console.error("[dev] After installation, restart your terminal and run npm run dev again.");
    console.error("=".repeat(70) + "\n");
    process.exit(1);
  }

  console.log("[dev] ✅ Dependencies verified, continuing startup...\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await ensureDependencies();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
