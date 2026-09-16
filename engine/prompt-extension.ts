import type { ExtensionAPI } from "../pi/packages/coding-agent/src/index.ts";
import {
  createBashToolDefinition,
  createLocalBashOperations,
  type BashOperations,
} from "../pi/packages/coding-agent/src/core/tools/bash.ts";
import { registerWorkspacePaths } from "../backend/resources/workspace-paths.mjs";

export default function (pi: ExtensionAPI) {
  // Planner owns its restricted inspection tool; Partitioner has no tools.
  // The launcher loads this adapter for every role, so execution-only tool
  // overrides and hooks must not register on either planning role.
  if (process.env.GRAPHER_MODE === "planner") return;
  const paths = registerWorkspacePaths(pi, process.env.GRAPHER_WORKSPACE_ROOT || process.cwd());
  if (process.env.GRAPHER_MODE === "partition") return;

  const toolCallExitCodes = new Map<string, { exitCode: number | null; command: string; truncated?: boolean }>();
  const localOps = createLocalBashOperations();
  const baseBashTool = createBashToolDefinition(paths.root);

  pi.registerTool({
    ...baseBashTool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const rawCmd = params.command;
      const cmd = (rawCmd.startsWith("set -E -e -o pipefail") || rawCmd.startsWith("set -e -E -o pipefail"))
        ? rawCmd
        : `set -E -e -o pipefail\n${rawCmd}`;
      params.command = cmd;

      // Call-local isolated exit code variable specific to this invocation closure
      let callExitCode: number | null = null;
      const scopedOps: BashOperations = {
        exec: async (command, cwd, options) => {
          const res = await localOps.exec(command, cwd, options);
          callExitCode = res.exitCode;
          return res;
        },
      };

      const scopedBashTool = createBashToolDefinition(paths.root, {
        operations: scopedOps,
      });

      let result: any;
      let execError: any;
      try {
        const mappedUpdate = onUpdate ? (update: any) => onUpdate(paths.view(update)) : undefined;
        result = await scopedBashTool.execute(toolCallId, params, signal, mappedUpdate, ctx ? { ...ctx, cwd: paths.root } : ctx);
      } catch (err) {
        execError = err;
      }

      const exitCode = callExitCode;
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
      // Strictly preserve null when unknown; NEVER guess 0 without provenance
      const exitCode = recorded ? recorded.exitCode : null;
      const details = ((event.details || {}) as Record<string, unknown>);
      details.exitCode = exitCode;
      details.command = recorded?.command ?? event.input?.command;
      details.truncated = recorded?.truncated ?? !!(details.truncation as any)?.truncated;
      return {
        details: paths.view(details),
        isError: event.isError,
      };
    }
  });
}
