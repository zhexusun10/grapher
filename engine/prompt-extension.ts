import type { ExtensionAPI } from "../pi/packages/coding-agent/src/index.ts";
import {
  createBashToolDefinition,
  createLocalBashOperations,
  type BashOperations,
} from "../pi/packages/coding-agent/src/core/tools/bash.ts";
import { grapherSystemPrompt } from "./system-prompt.mjs";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async event => ({ systemPrompt: grapherSystemPrompt(event.systemPrompt) }));

  const toolCallExitCodes = new Map<string, { exitCode: number | null; command: string; truncated?: boolean }>();
  let pendingExitCode: number | null = null;

  const localOps = createLocalBashOperations();
  const customOps: BashOperations = {
    exec: async (command, cwd, options) => {
      const res = await localOps.exec(command, cwd, options);
      pendingExitCode = res.exitCode;
      return res;
    },
  };

  const baseBashTool = createBashToolDefinition(process.cwd(), {
    operations: customOps,
  });

  pi.registerTool({
    ...baseBashTool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const rawCmd = params.command;
      const cmd = (rawCmd.startsWith("set -E -e -o pipefail") || rawCmd.startsWith("set -e -E -o pipefail"))
        ? rawCmd
        : `set -E -e -o pipefail\n${rawCmd}`;
      params.command = cmd;

      pendingExitCode = null;
      let result: any;
      let execError: any;
      try {
        result = await baseBashTool.execute(toolCallId, params, signal, onUpdate, ctx);
      } catch (err) {
        execError = err;
      }

      const exitCode = pendingExitCode;
      const isTruncated = !!(result?.details?.truncation?.truncated || result?.details?.truncated);
      toolCallExitCodes.set(toolCallId, { exitCode, command: rawCmd, truncated: isTruncated });

      if (execError) {
        throw execError;
      }

      return {
        ...result,
        details: {
          ...result?.details,
          exitCode,
          command: rawCmd,
          truncated: isTruncated,
        },
      };
    },
  });

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
      const recorded = toolCallExitCodes.get(event.toolCallId);
      if (recorded) {
        toolCallExitCodes.delete(event.toolCallId);
      }
      const exitCode = recorded ? recorded.exitCode : (event.isError ? null : 0);
      const details = ((event.details || {}) as Record<string, unknown>);
      details.exitCode = exitCode;
      details.command = recorded?.command ?? event.input?.command;
      details.truncated = recorded?.truncated ?? !!(details.truncation as any)?.truncated;
      return {
        details,
        isError: event.isError,
      };
    }
  });
}
