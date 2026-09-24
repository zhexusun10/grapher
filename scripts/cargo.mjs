import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const APPLE_COMMAND_LINE_TOOLS = "/Library/Developer/CommandLineTools";

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

function cargoExecutable() {
  if (process.env.CARGO) return process.env.CARGO;
  const rustupCargo = join(homedir(), ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo");
  return existsSync(rustupCargo) ? rustupCargo : "cargo";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const child = spawn(cargoExecutable(), process.argv.slice(2), {
    env: toolchainEnv(),
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
