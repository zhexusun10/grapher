import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const cargoBin = path.join(os.homedir(), ".cargo", "bin");
const sep = process.platform === "win32" ? ";" : ":";
const currentPath = process.env.PATH || "";
const pathParts = currentPath.split(sep);

let newPath = currentPath;
if (fs.existsSync(cargoBin) && !pathParts.includes(cargoBin)) {
  newPath = `${cargoBin}${sep}${currentPath}`;
}

const args = process.argv.slice(2);
const tauriBin = path.resolve(
  process.platform === "win32"
    ? "./node_modules/.bin/tauri.cmd"
    : "./node_modules/.bin/tauri"
);

const proc = spawn(tauriBin, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    PATH: newPath,
  },
  shell: process.platform === "win32",
});

proc.on("exit", (code) => {
  process.exit(code ?? 0);
});
