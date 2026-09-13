import { spawn, execSync } from "node:child_process";
import { homedir } from "node:os";

const cargoBin = `${homedir()}/.cargo/bin`;
if (!process.env.PATH?.includes(cargoBin)) {
  process.env.PATH = `${cargoBin}:${process.env.PATH ?? ""}`;
}

const frontendPort = 1420;
const backendPort = process.env.GRAPHER_PORT || 1421;

function killPortListeners(...ports) {
  for (const port of ports) {
    try {
      const output = execSync(`lsof -nP -sTCP:LISTEN -ti:${port}`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (!output) continue;
      const pids = output
        .split(/\s+/)
        .map((p) => Number.parseInt(p, 10))
        .filter((pid) => pid && pid !== process.pid);
      for (const pid of pids) {
        console.log(`[dev] Port ${port} is in use by PID ${pid}, killing...`);
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    } catch {}
  }
}

killPortListeners(frontendPort, backendPort);

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
  killPortListeners(frontendPort, backendPort);
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
