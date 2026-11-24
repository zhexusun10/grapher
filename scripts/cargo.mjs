import { spawn, execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const APPLE_COMMAND_LINE_TOOLS = "/Library/Developer/CommandLineTools";
const MACOS_COMPATIBILITY_SDK_MAJOR = 26;

// Windows environment variable names are case-insensitive, but the block a
// process receives depends on the launcher: Explorer/PowerShell chains deliver
// "Path" while POSIX shells deliver "PATH". Writing "PATH" next to an existing
// "Path" produces a child environment block with both names, and spawn then
// fails to locate executables at all (observed as `git` ENOENT). Resolve and
// mutate the single existing entry instead of assuming a key casing.
export function pathKey(env = process.env) {
  return Object.keys(env).find(name => /^path$/i.test(name)) ?? "PATH";
}

export function pathValue(env = process.env) {
  return env[pathKey(env)] ?? "";
}

// Mutates the plain-object `env` in place and returns it.
export function prependPath(env, ...entries) {
  const key = pathKey(env);
  for (const name of Object.keys(env)) {
    if (name !== key && /^path$/i.test(name)) delete env[name];
  }
  env[key] = [...entries, env[key]].flat().filter(Boolean).join(delimiter);
  return env;
}

export function toolchainEnv(base = process.env) {
  const env = { ...base };
  if (
    process.platform === "darwin" &&
    !env.DEVELOPER_DIR &&
    existsSync(join(APPLE_COMMAND_LINE_TOOLS, "SDKs", "MacOSX.sdk"))
  ) {
    env.DEVELOPER_DIR = APPLE_COMMAND_LINE_TOOLS;
  }
  return env;
}

function parseSdkMajorVersion(versionText) {
  const match = String(versionText ?? "").trim().match(/^(\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function readActiveMacosSdkVersion(env) {
  try {
    return execFileSync("xcrun", ["--show-sdk-version"], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function defaultMacosSdkSearchDirs() {
  const dirs = [join(APPLE_COMMAND_LINE_TOOLS, "SDKs")];
  try {
    const apps = readdirSync("/Applications")
      .filter(name => /^Xcode.*\.app$/i.test(name))
      .sort();
    for (const app of apps) {
      dirs.push(join("/Applications", app, "Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs"));
    }
  } catch {
    // Ignore unreadable /Applications directories.
  }
  return dirs;
}

function isUsableSdkDir(sdkPath) {
  return (
    existsSync(join(sdkPath, "SDKSettings.plist")) ||
    existsSync(join(sdkPath, "SDKSettings.json"))
  );
}

/**
 * Locate an installed macOS 26 SDK (`MacOSX26*.sdk`).
 * Apple ignores `UIDesignRequiresCompatibility` for binaries linked against the
 * macOS 27+ SDK, so desktop builds prefer a macOS 26 SDK when the active SDK is
 * 27+ to retain native non-Liquid-Glass window controls on macOS 26/27.
 */
export function findMacosCompatibilitySdk({
  sdkDirs = defaultMacosSdkSearchDirs(),
} = {}) {
  const candidates = [];
  for (const dir of sdkDirs) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const match = entry.match(/^MacOSX26(?:\.(\d+))?\.sdk$/);
      if (!match) continue;
      const rawPath = join(dir, entry);
      let resolvedPath = rawPath;
      try {
        resolvedPath = realpathSync(rawPath);
      } catch {
        continue;
      }
      if (!isUsableSdkDir(resolvedPath)) continue;
      const resolvedMatch = resolvedPath.match(/MacOSX26(?:\.(\d+))?\.sdk$/);
      const minor = resolvedMatch?.[1] != null
        ? Number.parseInt(resolvedMatch[1], 10)
        : (match[1] != null ? Number.parseInt(match[1], 10) : -1);
      candidates.push({ path: resolvedPath, minor });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.minor - a.minor);
  return candidates[0].path;
}

export function macosDesktopToolchainEnv(
  base = process.env,
  {
    platform = process.platform,
    activeSdkVersion = undefined,
    sdkDirs = undefined,
  } = {},
) {
  const env = toolchainEnv(base);
  if (platform !== "darwin") return env;
  if (typeof env.SDKROOT === "string" && env.SDKROOT.trim()) {
    return env;
  }
  const activeVersion = activeSdkVersion !== undefined
    ? activeSdkVersion
    : readActiveMacosSdkVersion(env);
  const major = parseSdkMajorVersion(activeVersion);
  if (major !== null && major <= MACOS_COMPATIBILITY_SDK_MAJOR) {
    return env;
  }
  const compatSdk = findMacosCompatibilitySdk(sdkDirs ? { sdkDirs } : {});
  if (compatSdk) {
    env.SDKROOT = compatSdk;
  }
  return env;
}

function cargoExecutable() {
  if (process.env.CARGO) return process.env.CARGO;
  const rustupCargo = join(homedir(), ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo");
  return existsSync(rustupCargo) ? rustupCargo : "cargo";
}

export function cargoTestEnv(base = process.env) {
  const env = toolchainEnv(base);
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (
      upper.startsWith("GRAPHER_") &&
      upper !== "GRAPHER_ENV_SEAL_PROBE_REPORT" &&
      !upper.startsWith("GRAPHER_ENV_PROBE_") &&
      !upper.startsWith("GRAPHER_ENV_TEST_")
    ) {
      delete env[key];
    } else if (
      /^PI_(?:SESSION_ID|SESSION_FILE|CODING_AGENT_DIR|CODING_AGENT|MODEL|PROVIDER|REASONING_LEVEL|THINKING)$/i.test(key)
    ) {
      delete env[key];
    }
  }
  return env;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const child = spawn(cargoExecutable(), args, {
    env: args[0] === "test" ? cargoTestEnv() : toolchainEnv(),
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (process.platform === "win32" && child.pid) {
        try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
      } else {
        child.kill(signal);
      }
    });
  }
  child.on("error", error => {
    console.error(`Cannot start Cargo: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143);
  });
}
