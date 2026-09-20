// The only production Provider/Auth binding to Pi: its public SDK export.
import { createInterface } from "node:readline";
import { ModelRuntime } from "../pi/packages/coding-agent/src/index.ts";
import { ProviderAuthAdapter } from "./provider-auth-adapter.mjs";
import { verifyBaseline } from "../scripts/pi-baseline.mjs";
import { configureAgentDir } from "./agent-dir.mjs";

configureAgentDir();
verifyBaseline();
const adapter = new ProviderAuthAdapter((options: Parameters<typeof ModelRuntime.create>[0]) => ModelRuntime.create(options));
const input = createInterface({ input: process.stdin, terminal: false });
input.on("line", async (line) => {
  try {
    if (line.length > 131072) throw new Error("Request too large");
    const result = await adapter.dispatch(JSON.parse(line));
    process.stdout.write(`${JSON.stringify({ version: 1, result })}\n`);
  } catch {
    // No raw exception, request body, or credential object crosses this boundary.
    process.stdout.write(`${JSON.stringify({ version: 1, error: "Provider/Auth operation failed. Refresh providers or restart login." })}\n`);
  }
});
const close = () => { adapter.close(); process.exit(0); };
input.on("close", close);
process.on("SIGTERM", close);
process.on("SIGINT", close);
