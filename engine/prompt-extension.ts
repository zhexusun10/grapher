import { createWorkspacePaths } from './workspace-paths.mjs';
import { registerWorkspaceTools } from './workspace-tools.ts';
import { managedLaunch, managedBashOptions, managedBashCommand } from './launch-binding.mjs';
import {
  createBashToolDefinition,
  createLocalBashOperations,
  type BashOperations,
  type ExtensionAPI,
} from './pi-compat.ts';

const INTERRUPTED_CONTINUATION = '__grapher_continue_interrupted__';

export default function (pi: ExtensionAPI) {
  const continuation = process.env.GRAPHER_CONTINUE_INTERRUPTED === 'true';
  const cwd = process.cwd();
  if (continuation) {
    // The host sends a private RPC marker. Intercept it before Pi appends a
    // user message, then start an empty custom turn. The context hook below
    // removes the incomplete assistant/tool protocol; pi-continuity and Pi's
    // public session boundary continue the existing task without a synthetic
    // "continue" instruction.
    pi.on('input', event => {
      if (event.text !== INTERRUPTED_CONTINUATION) return { action: 'continue' };
      pi.sendMessage({
        customType: 'grapher-interrupted-continuation',
        content: [],
        display: false,
        details: { reason: 'grapher-interrupted-node' },
      }, { triggerTurn: true });
      return { action: 'handled' };
    });
    pi.on('context', event => {
      const lastAssistant = event.messages.findLastIndex(message =>
        message.role === 'assistant' &&
        ['toolUse', 'error', 'aborted', 'length'].includes(message.stopReason));
      if (lastAssistant < 0) return;
      return {
        messages: event.messages.filter((_message, index) => index !== lastAssistant &&
          !(_message.role === 'custom' && _message.customType === 'grapher-interrupted-continuation')),
      };
    });
  }

  const planner = process.env.GRAPHER_MODE === 'planner';
  const partition = process.env.GRAPHER_MODE === 'partition';
  const graph = process.env.GRAPHER_EXECUTION_KIND === 'graph';
  const project = process.env.GRAPHER_ORIGINAL_ROOT || (planner && !graph ? cwd : undefined);
  // Planner uses the same model-facing namespace before, during and after
  // private execution. Its physical cwd is backend/UI metadata, not a prompt.
  const paths = !partition && (graph || planner) && project
    ? createWorkspacePaths(cwd, project, process.env.GRAPHER_SOURCE_ALIAS || project) : undefined;
  const view = (value: any): any => paths ? paths.view(value) : value;
  // Execution roles receive path guidance directly; Planner need not repeat it in handoffs.
  const pathGuideline = 'Use project-root-relative paths in Bash commands and project files.';
  if (!partition && (paths || !planner)) {
    pi.on('before_agent_start', async event => {
      // Pi 1.0 projects forceSystemPrompt after context_with_system handlers.
      // Returning systemPrompt here would overwrite pi-trim's request-time edits.
      // Keep ordinary prompts structured so the upstream extension can trim them.
      const options = event.systemPromptOptions;
      if (paths) Object.assign(options, paths.view(options));
      // Normalize existing prompt paths only. Planner gets no extra addendum,
      // cwd announcement, environment hint or instruction to re-read files.
      if (planner) return;
      const hints = process.env.GRAPHER_PREVIOUS_AGENT_ENVIRONMENT_HINTS?.trim();
      const guidance = hints ? `${pathGuideline}\n${hints}` : pathGuideline;
      if (options.forceSystemPrompt !== undefined) {
        // Respect an explicit override supplied by another extension. Such
        // overrides require separate compatibility review with Pi's projection.
        const preceding = options.forceSystemPrompt.trimEnd();
        options.forceSystemPrompt = `${preceding}${preceding ? '\n' : ''}${guidance}`;
      } else {
        const preceding = options.appendSystemPrompt.trimEnd();
        options.appendSystemPrompt = `${preceding}${preceding ? '\n' : ''}${guidance}`;
      }
    });
  }
  // Partitioner has no tools. Planner shares the execution path adapter but
  // retains its read/bash surface; node/edge belong to the Planner extension.
  if (partition) return;
  if (graph && !project) throw new Error('Graph execution is missing its host-owned project binding');
  if (paths && project) {
    registerWorkspaceTools(pi, cwd, project, process.env.GRAPHER_SOURCE_ALIAS || project, view,
      planner ? ['read'] : undefined);

    // Normalize model-facing paths only; never change stored files, tool input
    // contents, provider signatures, or image bytes.
    pi.on('context', async event => ({ messages: view(event.messages) }));
    pi.on('tool_result', async event => ({ content: view(event.content), details: view(event.details) }));
  }

  const toolCallExitCodes = new Map<string, { exitCode: number | null; command: string; truncated?: boolean }>();
  const launch = managedLaunch();
  const localOps = createLocalBashOperations(launch ? { shellPath: launch.shell } : undefined);
  const baseBashTool = createBashToolDefinition(cwd);
  if (launch) {
    pi.on('user_bash', async () => ({ operations: {
      exec: (command, workingDirectory, options) => localOps.exec(managedBashCommand(paths ? paths.command(command) : command),
        workingDirectory, managedBashOptions(options)),
    } }));
  }

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
          const res = await localOps.exec(managedBashCommand(command), cwd, managedBashOptions(options));
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
