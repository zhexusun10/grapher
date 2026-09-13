// Grapher-owned launcher. No global Pi fallback and no changes to upstream code.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { root, source, verifyBaseline } from "../scripts/pi-baseline.mjs";

try {
  verifyBaseline();
  const child = spawn(process.execPath, [
    join(source, "node_modules/tsx/dist/cli.mjs"),
    "--tsconfig", join(source, "tsconfig.json"),
    join(source, "packages/coding-agent/src/cli.ts"),
    ...process.argv.slice(2),
    "--extension", join(root, "engine/prompt-extension.ts"),
  ], { stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
  child.on("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143); });
} catch (error) {
  console.error(`Execution Instance Engine unavailable: ${error.message}`);
  process.exitCode = 1;
}
