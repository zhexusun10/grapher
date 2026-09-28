import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const piSource = join(root, "pi");
export const viteBin = join(root, "node_modules", "vite", "bin", "vite.js");
export const piPackageJson = join(piSource, "package.json");
export const piDist = join(piSource, "packages", "ai", "dist");

/**
 * 快速检查 Cargo 是否安装，纯同步文件路径检查，耗时 < 0.1ms。
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

/**
 * 纯内存与同步快速检查状态，零子进程开销，通常耗时 < 0.5ms。
 */
export function checkDependenciesFast() {
  const missingSubmodule = !existsSync(piPackageJson);
  const missingRootModules = !existsSync(viteBin);
  const missingPiDist = !existsSync(piDist);
  const cargoPath = findCargoExecutable();
  const missingCargo = !cargoPath;

  return {
    missingSubmodule,
    missingRootModules,
    missingPiDist,
    missingCargo,
    cargoPath,
    allReady: !missingSubmodule && !missingRootModules && !missingPiDist && !missingCargo,
  };
}

/**
 * 跨平台执行 npm 指令
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
 * 确保所有依赖已就绪。
 * 若依赖已齐全，耗时 < 2ms 直接返回。
 * 若有缺失，按顺序自动拉取并安装。
 */
export async function ensureDependencies() {
  const status = checkDependenciesFast();

  // 依赖全齐时的极速路径：零子进程，耗时 < 2ms
  if (status.allReady) {
    return;
  }

  console.log("\n[dev] 正在检查并自动安装缺失的依赖...");

  // 1. 检查并拉取 Git Submodule (pi)
  if (status.missingSubmodule) {
    console.log("[dev] [1/3] 未检测到 pi 引擎子模块，正在执行 git submodule update --init --recursive...");
    try {
      execFileSync("git", ["submodule", "update", "--init", "--recursive"], {
        stdio: "inherit",
        cwd: root,
      });
      console.log("[dev] [1/3] pi 引擎子模块拉取完成。");
    } catch (error) {
      console.error("[dev] ❌ 拉取 git submodule 失败:", error.message);
      throw error;
    }
  }

  // 2. 检查并安装根目录依赖 (前端与开发工具)
  if (status.missingRootModules) {
    console.log("[dev] [2/3] 未检测到根目录依赖 (node_modules)，正在执行 npm ci --ignore-scripts...");
    try {
      runNpm(["ci", "--ignore-scripts"], { cwd: root });
    } catch (err) {
      console.warn("[dev] npm ci 失败，尝试执行 npm install --ignore-scripts...");
      runNpm(["install", "--ignore-scripts"], { cwd: root });
    }
    console.log("[dev] [2/3] 根目录依赖安装完成。");
  }

  // 3. 检查并初始化 Pi 引擎依赖与离线构建
  if (status.missingPiDist || !existsSync(join(piSource, "node_modules"))) {
    console.log("[dev] [3/3] 未检测到 Pi 引擎构建产物，正在执行 npm run pi:setup...");
    try {
      const piBaselineScript = join(root, "scripts", "pi-baseline.mjs");
      execFileSync(process.execPath, [piBaselineScript, "setup"], {
        stdio: "inherit",
        cwd: root,
        env: { ...process.env, npm_execpath: process.env.npm_execpath },
      });
      console.log("[dev] [3/3] Pi 引擎依赖与构建完成。");
    } catch (error) {
      console.error("[dev] ❌ Pi 引擎初始化失败:", error.message);
      throw error;
    }
  }

  // 4. Rust / Cargo 环境检查与友好提示
  if (status.missingCargo) {
    console.error("\n" + "=".repeat(70));
    console.error("[dev] ❌ 未检测到 Rust/Cargo 编译工具链！");
    console.error("[dev] 本项目后端服务由 Rust 编写，开发与运行必须依赖 Cargo。");
    console.error("[dev] 请先安装 Rust 环境：");
    if (process.platform === "win32") {
      console.error("[dev]   👉 Windows 请访问: https://rustup.rs/ 下载并安装 rustup-init.exe");
    } else {
      console.error("[dev]   👉 请在终端运行: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh");
    }
    console.error("[dev] 安装完成后，请重启终端并重新执行 npm run dev。");
    console.error("=".repeat(70) + "\n");
    process.exit(1);
  }

  console.log("[dev] ✅ 依赖检查完成，继续启动服务...\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await ensureDependencies();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
