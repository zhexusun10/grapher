import { spawn, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const cargoBin = join(homedir(), ".cargo", "bin");
if (!(process.env.PATH ?? "").split(delimiter).includes(cargoBin)) {
  process.env.PATH = [cargoBin, process.env.PATH ?? ""].filter(Boolean).join(delimiter);
}

const frontendPort = 1420;
const backendPort = Number(process.env.GRAPHER_PORT) || 1421;

function portListenerPids(port) {
  if (process.platform === "win32") {
    try {
      const output = execFileSync("netstat", ["-ano", "-p", "tcp"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const pids = new Set();
      for (const line of output.split(/\r?\n/)) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 5 || fields[0] !== "TCP" || fields[3] !== "LISTENING") continue;
        const local = fields[1].replace(/^\[|\]$/g, "");
        if (local.endsWith(`:${port}`)) {
          const pid = Number.parseInt(fields[4], 10);
          if (pid && pid !== process.pid) pids.add(pid);
        }
      }
      return [...pids];
    } catch {
      return [];
    }
  }

  try {
    const output = execFileSync("lsof", ["-nP", "-sTCP:LISTEN", "-ti", `:${port}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return [...new Set(output.split(/\s+/)
      .map((value) => Number.parseInt(value, 10))
      .filter((pid) => pid && pid !== process.pid))];
  } catch {
    return [];
  }
}

async function cleanPorts(...ports) {
  for (const port of ports) {
    const pids = portListenerPids(port);
    if (pids.length > 0) {
      throw new Error(
        `Port ${port} is already in use by PID${pids.length === 1 ? "" : "s"} ${pids.join(", ")}. Stop that process manually before starting Grapher; dev will not terminate processes it did not start.`,
      );
    }
  }
}

await cleanPorts(frontendPort, backendPort);

const children = [];
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.pid) {
      terminateChild(child);
    }
  }
  await Promise.all(children.map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => {
      terminateChild(child, true);
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  })));
  process.exitCode = code;
}

function terminateChild(child, force = false) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
    return;
  }
  try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); }
  catch { try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch {} }
}

process.on("SIGINT", () => { void stop(); });
process.on("SIGTERM", () => { void stop(); });

function waitForBackend(port, timeoutMs = 60000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    async function check() {
      if (stopping) return reject(new Error("Process stopping"));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, {
          signal: AbortSignal.timeout(800),
        });
        if (res.status) return resolve();
      } catch {
        // Backend not ready yet.
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timeout waiting for backend on port ${port}`));
      } else {
        setTimeout(check, 150);
      }
    }
    check();
  });
}

function childOptions() {
  return {
    stdio: "inherit",
    // Unix needs a process group for tree termination. Windows uses taskkill
    // and the backend's Job Object lifecycle instead.
    detached: process.platform !== "win32",
  };
}

console.log(`[dev] Starting backend (cargo run --manifest-path backend/Cargo.toml --bin grapher)...`);
const backend = spawn("cargo", ["run", "--manifest-path", "backend/Cargo.toml", "--bin", "grapher"], childOptions());
children.push(backend);

backend.on("error", (error) => {
  console.error(`[dev] Failed to spawn backend: ${error.message}`);
  void stop(1);
});

backend.on("exit", (code) => {
  if (!stopping) {
    console.error(`[dev] Backend process exited unexpectedly with code ${code ?? 0}`);
    void stop(code ?? 1);
  }
});

console.log(`[dev] Waiting for backend to listen on port ${backendPort}...`);
try {
  await waitForBackend(backendPort, 60000);
} catch (error) {
  if (!stopping) {
    console.error(`[dev] Backend startup failed or timed out: ${error.message}`);
    await stop(1);
  }
  process.exit(process.exitCode ?? 1);
}

if (stopping) process.exit(process.exitCode ?? 0);

console.log(`[dev] Backend ready on http://127.0.0.1:${backendPort}. Starting frontend (vite)...`);
const frontend = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"], childOptions());
children.push(frontend);

frontend.on("error", (error) => {
  console.error(`[dev] Failed to spawn frontend: ${error.message}`);
  void stop(1);
});

frontend.on("exit", (code) => {
  if (!stopping) {
    console.log(`[dev] Frontend exited with code ${code ?? 0}`);
    void stop(code ?? 1);
  }
});
