import { createWorkspacePaths } from './workspace-paths.mjs';
import { registerWorkspaceTools } from './workspace-tools.ts';
import type { ExtensionAPI } from "../pi/packages/coding-agent/src/index.ts";
import {
  createBashToolDefinition,
  createLocalBashOperations,
  type BashOperations,
} from "../pi/packages/coding-agent/src/core/tools/bash.ts";

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const project = process.env.GRAPHER_ORIGINAL_ROOT;
  const paths = process.env.GRAPHER_EXECUTION_KIND === 'graph' && project
    ? createWorkspacePaths(cwd, project, process.env.GRAPHER_SOURCE_ALIAS || project) : undefined;
  const view = (value: any): any => paths ? paths.view(value) : value;
  // A shared convention, not a change to filesystem resolution. Each shell
  // still observes cd; ../ is never redirected to the source project's parent.
  if (process.env.GRAPHER_MODE !== 'partition') {
    pi.on('before_agent_start', async event => ({
      systemPrompt: `${paths ? paths.visible(event.systemPrompt) : event.systemPrompt}\n\nUse project-root-relative paths for project files, node handoffs and generated configuration. Use original host absolute paths for external files and scripts. In bash, relative paths follow the shell's current directory after cd. Do not use ../ to mean the source project's parent; use an explicit host absolute path for external siblings. Existing absolute project references are compatibility inputs, not the preferred form for new work.`,
    }));
  }
  // Planner owns its native bash tool; Partitioner has no tools.
  // The launcher loads this adapter for every role, so execution-only tool
  // overrides and hooks must not register on either planning role.
  if (process.env.GRAPHER_MODE === "planner") return;
  if (process.env.GRAPHER_MODE === "partition") return;
  if (process.env.GRAPHER_EXECUTION_KIND === 'graph') {
    if (!project) throw new Error('Graph execution is missing its host-owned project binding');
    registerWorkspaceTools(pi, cwd, project, process.env.GRAPHER_SOURCE_ALIAS || project, view);

    // Normalize model-facing paths only; never change stored files, tool input
    // contents, provider signatures, or image bytes.
    pi.on('context', async event => ({ messages: view(event.messages) }));
    pi.on('tool_result', async event => ({ content: view(event.content), details: view(event.details) }));
  }

  const toolCallExitCodes = new Map<string, { exitCode: number | null; command: string; truncated?: boolean }>();
  const localOps = createLocalBashOperations();
  const baseBashTool = createBashToolDefinition(cwd);

  pi.registerTool({
    ...baseBashTool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // Preserve native bash semantics. Callers can request errexit/pipefail
      // explicitly; injecting them changes otherwise valid shell programs.
      const rawCmd = params.command;

      // Call-local isolated exit code variable specific to this invocation closure
      let callExitCode: number | null = null;
      const scopedOps: BashOperations = {
        exec: async (command, cwd, options) => {
          const res = await localOps.exec(command, cwd, options);
          callExitCode = res.exitCode;
          return res;
        },
      };

      const scopedBashTool = createBashToolDefinition(cwd, {
        operations: scopedOps,
      });

      let result: any;
      let execError: any;
      try {
        const mapped = { ...params, command: paths ? paths.command(rawCmd) : rawCmd };
        result = view(await scopedBashTool.execute(toolCallId, mapped, signal,
          onUpdate ? update => onUpdate(view(update)) : undefined, ctx));
      } catch (err) {
        execError = err;
      }

      const exitCode = callExitCode;
      const isTruncated = !!(result?.details?.truncation?.truncated || result?.details?.truncated);
      toolCallExitCodes.set(toolCallId, { exitCode, command: rawCmd, truncated: isTruncated });

      if (execError) {
        if (execError instanceof Error && paths) execError.message = paths.visible(execError.message);
        throw execError;
      }

      return {
        ...result,
        details: view({
          ...result?.details,
          exitCode,
          command: rawCmd,
          truncated: isTruncated,
        }),
      };
    },
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
        details: view(details),
        isError: event.isError,
      };
    }
  });
}
