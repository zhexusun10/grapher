import { execSync } from "node:child_process";

const PORT = process.env.PORT || 1420;

function freePort(port) {
  const currentPid = process.pid;
  try {
    if (process.platform === "win32") {
      const stdout = execSync(`netstat -ano | findstr :${port}`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const lines = stdout.trim().split("\n");
      const pids = new Set();
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && pid !== "0" && pid !== String(currentPid)) {
          pids.add(pid);
        }
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
          console.log(`[free-port] 已终止占用端口 ${port} 的进程 (PID: ${pid})`);
        } catch {}
      }
    } else {
      // macOS & Linux
      const stdout = execSync(`lsof -ti :${port}`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (stdout) {
        const pids = stdout.split("\n").map((p) => p.trim()).filter(Boolean);
        for (const pid of pids) {
          if (pid !== String(currentPid)) {
            try {
              execSync(`kill -9 ${pid}`, { stdio: "ignore" });
              console.log(`[free-port] 已终止占用端口 ${port} 的进程 (PID: ${pid})`);
            } catch {}
          }
        }
      }
    }
  } catch {
    // 端口未被占用或查询失败，安全忽略
  }
}

freePort(PORT);
