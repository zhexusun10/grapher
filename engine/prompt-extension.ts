import type { ExtensionAPI } from "../pi/packages/coding-agent/src/index.ts";
import { grapherSystemPrompt } from "./system-prompt.mjs";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async event => ({ systemPrompt: grapherSystemPrompt(event.systemPrompt) }));

  pi.on("tool_call", async event => {
    if (event.toolName === "bash" && typeof event.input?.command === "string") {
      const raw = event.input.command;
      if (!raw.startsWith("set -E -e -o pipefail") && !raw.startsWith("set -e -E -o pipefail")) {
        event.input.command = `set -E -e -o pipefail\n${raw}`;
      }
    }
  });

  pi.on("tool_result", async event => {
    if (event.toolName === "bash") {
      let exitCode = 0;
      const text = event.content?.map(c => (c.type === "text" ? c.text : "")).join("\n") || "";
      const match = text.match(/Command exited with code (\d+)/);
      if (match) {
        exitCode = parseInt(match[1], 10);
      } else if (event.isError) {
        exitCode = 1;
      }
      const details = ((event.details || {}) as Record<string, unknown>);
      details.exitCode = exitCode;
      details.command = event.input?.command;
      details.truncated = !!(details.truncation as any)?.truncated;
      return {
        details,
        isError: event.isError || exitCode !== 0,
      };
    }
  });
}
