// Grapher-owned launcher. No global Pi fallback and no changes to upstream code.
import { root, verifyRuntimeBaseline } from "../scripts/pi-baseline.mjs";
import { applyDisabledProviders, configureAgentDir } from "./agent-dir.mjs";

let verified = false;
try {
  configureAgentDir();
  verifyRuntimeBaseline({ installationRoot: root });
  applyDisabledProviders(process.env);
  verified = true;
} catch (error) {
  console.error(`Execution Instance Engine unavailable: ${error.message}`);
  process.exitCode = 1;
}

if (verified) {
  await import("./execution-cli.ts");
}
