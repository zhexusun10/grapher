import type { ExtensionAPI } from "../pi/packages/coding-agent/src/index.ts";
import { grapherSystemPrompt } from "./system-prompt.mjs";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async event => ({ systemPrompt: grapherSystemPrompt(event.systemPrompt) }));
}
