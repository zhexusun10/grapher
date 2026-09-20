import { spawn, execSync } from "node:child_process";
import { homedir } from "node:os";
import net from "node:net";

const cargoBin = `${homedir()}/.cargo/bin`;
if (!process.env.PATH?.includes(cargoBin)) {
  process.env.PATH = `${cargoBin}:${process.env.PATH ?? ""}`;
}

const frontendPort = 1420;
const backendPort = Number(process.env.GRAPHER_PORT) || 1421;

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

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());

function waitForPort(port, timeoutMs = 60000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function check() {
      if (stopping) {
        return reject(new Error("Process stopping"));
      }
      const socket = net.createConnection({ port, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.end();
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timeout waiting for port ${port}`));
        } else {
          setTimeout(check, 150);
        }
      });
    }
    check();
  });
}

// 1. 先启动后端
console.log(`[dev] Starting backend (cargo run --manifest-path backend/Cargo.toml --bin grapher)...`);
const backend = spawn("cargo", ["run", "--manifest-path", "backend/Cargo.toml", "--bin", "grapher"], {
  stdio: "inherit",
  detached: true,
});
children.push(backend);

backend.on("error", (error) => {
  console.error(`[dev] Failed to spawn backend: ${error.message}`);
  stop(1);
});

backend.on("exit", (code) => {
  if (!stopping) {
    console.error(`[dev] Backend process exited unexpectedly with code ${code ?? 0}`);
    stop(code ?? 1);
  }
});

// 2. 等待后端端口就绪
console.log(`[dev] Waiting for backend to listen on port ${backendPort}...`);
try {
  await waitForPort(backendPort, 60000);
} catch (error) {
  if (!stopping) {
    console.error(`[dev] Backend startup failed or timed out: ${error.message}`);
    stop(1);
  }
  process.exit(1);
}

if (stopping) {
  process.exit(process.exitCode ?? 0);
}

console.log(`[dev] Backend ready on http://127.0.0.1:${backendPort}. Starting frontend (vite)...`);

// 3. 后端就绪后再启动前端
const frontend = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"], {
  stdio: "inherit",
  detached: true,
});
children.push(frontend);

frontend.on("error", (error) => {
  console.error(`[dev] Failed to spawn frontend: ${error.message}`);
  stop(1);
});

frontend.on("exit", (code) => {
  if (!stopping) {
    console.log(`[dev] Frontend exited with code ${code ?? 0}`);
    stop(code ?? 1);
  }
});

