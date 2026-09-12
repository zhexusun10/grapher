import { spawn } from "node:child_process";

const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
    }
  }
  process.exitCode = code;
}
for (const [command, args] of [
  ["cargo", ["run", "--manifest-path", "backend/Cargo.toml", "--bin", "grapher"]],
  [process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"]],
]) {
  const child = spawn(command, args, { stdio: "inherit", detached: true });
  children.push(child);
  child.on("error", (error) => { console.error(error.message); stop(1); });
  child.on("exit", (code) => stop(code ?? 1));
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
