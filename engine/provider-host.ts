// The only production Provider/Auth binding to Pi: its public SDK export.
import { createInterface } from "node:readline";
import { ModelRuntime } from "./pi-compat.ts";
import { ProviderAuthAdapter } from "./provider-auth-adapter.mjs";
import { verifyBaseline } from "../scripts/pi-baseline.mjs";
import { configureAgentDir } from "./agent-dir.mjs";

configureAgentDir();
verifyBaseline();
const adapter = new ProviderAuthAdapter((options: Parameters<typeof ModelRuntime.create>[0]) => ModelRuntime.create(options));
const input = createInterface({ input: process.stdin, terminal: false });
let pending = 0;
let inputClosed = false;
const finish = () => {
  // A pipe may close immediately after its last line, while catalog/login is
  // still resolving. Drain replies before exiting; signals still cancel now.
  if (inputClosed && pending === 0) { adapter.close(); process.exit(0); }
};
input.on("line", async (line) => {
  pending++;
  let reply;
  try {
    if (line.length > 131072) throw new Error("Request too large");
    reply = { version: 1, result: await adapter.dispatch(JSON.parse(line)) };
  } catch {
    // No raw exception, request body, or credential object crosses this boundary.
    reply = { version: 1, error: "Provider/Auth operation failed. Refresh providers or restart login." };
  }
  // stdout is a pipe: a large catalog may still be buffered after write().
  // Exiting on stdin EOF before the write callback truncates the JSON reply.
  process.stdout.write(`${JSON.stringify(reply)}\n`, () => { pending--; finish(); });
});
const stop = () => { adapter.close(); process.exit(0); };
input.on("close", () => {
  inputClosed = true;
  // A vanished parent must not leave an interactive login child alive forever.
  if (pending) setTimeout(stop, 40000).unref();
  finish();
});
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
