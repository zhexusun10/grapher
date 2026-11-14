import { createWorkspacePaths } from './workspace-paths.mjs';
import { plannerSteerContext } from './planner-steer.ts';
import { feedbackInputContext } from './feedback-input.ts';
import { registerWorkspaceTools } from './workspace-tools.ts';
import { configurePlannerWorkspace, onPlannerWorkspaceChanged, plannerWorkspaceState, switchPlannerWorkspace } from './planner-workspace.ts';
import { managedLaunch, managedBashOptions, managedBashCommand } from './launch-binding.mjs';
import {
  createBashToolDefinition,
  createLocalBashOperations,
  obj,
  str,
  type BashOperations,
  type ExtensionAPI,
} from './pi-compat.ts';

const INTERRUPTED_CONTINUATION = '__grapher_continue_interrupted__';
const FEEDBACK_RULE = 'End your response with exactly one standalone final line:\n<ACCEPT>\nor\n<FEEDBACK>\nIf sending <FEEDBACK>, clearly describe the additional instruction for the target before the marker.';

export default function (pi: ExtensionAPI) {
  const continuation = process.env.GRAPHER_CONTINUE_INTERRUPTED === 'true';
  const cwd = process.cwd();
  // This is Grapher's workspace policy: a Grapher role always carries GRAPHER_MODE
  // (node/planner/partition/merger/result) and/or GRAPHER_EXECUTION_KIND. Capture
  // that once at factory time so the shell scrub still applies after any tool-time
  // env restoration, while the unmanaged compatibility process stays a no-op.
  const managedShell = !!process.env.GRAPHER_MODE || !!process.env.GRAPHER_EXECUTION_KIND;
  if (continuation) {
    // The host sends a private RPC marker. Intercept it before Pi appends a
    // user message, then start an empty custom turn. The context hook below
    // preserves completed tool exchanges and makes incomplete outcomes
    // explicit; pi-continuity and Pi's public session boundary continue the
    // existing task without a synthetic "continue" instruction.
    pi.on('input', event => {
      if (event.text !== INTERRUPTED_CONTINUATION) return { action: 'continue' };
      pi.sendMessage({
        customType: 'grapher-interrupted-continuation',
        content: [],
        display: false,
        details: { reason: process.env.GRAPHER_MODE === 'planner' ? 'grapher-interrupted-planner' : 'grapher-interrupted-node' },
      }, { triggerTurn: true });
      return { action: 'handled' };
    });
  }
  if (continuation || process.env.GRAPHER_MODE === 'node' || process.env.GRAPHER_MODE === 'planner') {
    pi.on('context', event => {
      // Match Pi's interrupted-response retry: omit a failed assistant and
      // its associated tool results from this request, not from saved history.
      // Leave ordinary tool-use turns, including missing results, untouched so
      // Pi's provider adapter performs its own native normalization.
      const messages = feedbackInputContext(event.messages).filter(message =>
        !(message.role === 'custom' && message.customType === 'grapher-interrupted-continuation'));
      const lastAssistant = messages.findLastIndex(message => message.role === 'assistant');
      const lastUser = messages.findLastIndex(message => message.role === 'user');
      const projected: typeof messages = [];
      let omittedCalls = new Set<string>();
      for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (message.role === 'assistant') {
          omittedCalls = new Set();
          const interrupted = ['error', 'aborted'].includes(message.stopReason) ||
            (continuation && message.stopReason === 'length' && index === lastAssistant && index > lastUser);
          if (interrupted) {
            if (Array.isArray(message.content)) {
              for (const block of message.content) {
                if (block.type === 'toolCall' && typeof block.id === 'string') omittedCalls.add(block.id);
              }
            }
            continue;
          }
        }
        if (message.role !== 'toolResult' || !omittedCalls.has(message.toolCallId)) projected.push(message);
      }
      return { messages: projected };
    });
  }

  const planner = process.env.GRAPHER_MODE === 'planner';
  // Correlation is retained in Pi's stored user turn for replay and recovery,
  // but must not change the prompt sent to the model on this or later turns.
  if (planner) pi.on('context', event => ({ messages: plannerSteerContext(event.messages) }));
  const plannerWriteTools = process.env.GRAPHER_PLANNER_WRITE_TOOLS === 'true';
  const partition = process.env.GRAPHER_MODE === 'partition';
  const graph = process.env.GRAPHER_EXECUTION_KIND === 'graph';
  const project = process.env.GRAPHER_ORIGINAL_ROOT || (planner && !graph ? cwd : undefined);
  // Planner uses the same model-facing namespace before, during and after
  // private execution. Its physical cwd is backend/UI metadata, not a prompt.
  let activePaths = !partition && (graph || planner) && project
    ? createWorkspacePaths(cwd, project, process.env.GRAPHER_SOURCE_ALIAS || project) : undefined;
  const paths = activePaths;
  const view = (value: any): any => activePaths ? activePaths.view(value) : value;
  // Private mapped roles receive path guidance directly; Planner need not repeat it in handoffs.
  const pathGuideline = 'Use project-root-relative paths in Bash commands and project files.';
  const graphNode = process.env.GRAPHER_MODE === 'node' &&
    (graph || process.env.GRAPHER_AGENT_KIND === 'node');
  if (graphNode) {
    // Pi owns the default rules and unconditionally adds its final path rule.
    // Replace only that top-level rule in request projections, including
    // mid-session system updates, without modifying stored history or custom prompts.
    pi.on('context_with_system', event => {
      let changed = false;
      const messages = event.messages.map(message => {
        if (message.role !== 'system' || typeof message.sections?.rules !== 'string') return message;
        const rules = message.sections.rules
          .replace(/^- Be concise in your responses(?:\r?\n|$)/gm, '')
          .replace(/^- Show file paths clearly when working with files\r?$/gm, `- ${pathGuideline}`);
        if (rules === message.sections.rules) return message;
        changed = true;
        return { ...message, sections: { ...message.sections, rules } };
      });
      return changed ? { messages } : undefined;
    });
  }
  const plannerTargets = planner && process.env.GRAPHER_PLANNER_FOLLOWUP === 'true'
    ? JSON.parse(process.env.GRAPHER_PLANNER_WORKSPACES || '{}') as Record<string, unknown>
    : {};
  if (planner && project && process.env.GRAPHER_PLANNER_FOLLOWUP === 'true' && Object.keys(plannerTargets).length > 0) {
    configurePlannerWorkspace(cwd, project, process.env.GRAPHER_SOURCE_ALIAS || project);
    activePaths = plannerWorkspaceState().paths;
    onPlannerWorkspaceChanged(next => { activePaths = next.paths; });
    pi.registerTool({
      name: 'switch_workspace',
      label: 'switch workspace',
      description: "Switch to the latest valid workspace state for a graph node. The result tells you the actual node and workspace state selected.",
      parameters: obj({
        id: str({ description: 'Id of the node whose latest workspace state you want to inspect or modify' }),
      }),
      promptSnippet: 'Switch Planner workspace',
      // Old Planner conversations can still produce the historical argument.
      // Normalize it before Pi validates the id-only model-facing schema.
      prepareArguments(raw: unknown) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.hasOwn(raw, 'node')) return raw;
        const { node, ...rest } = raw as Record<string, unknown>;
        if (Object.hasOwn(rest, 'id')) throw new Error('Supply id, not both id and legacy node.');
        return { ...rest, id: node };
      },
      async execute(_id: string, params: { id: string }) {
        const target = switchPlannerWorkspace(params.id);
        return { content: [{ type: 'text', text: JSON.stringify({
          switched: true,
          requestedId: target.requestedNode,
          actualId: target.actualNode,
          message: target.redirected
            ? `The requested node's workspace was inherited and modified by ${target.actualNode}; you are now at the latest downstream workspace state.`
            : `You are now at ${target.actualNode}'s workspace.`,
        }) }] };
      },
    } as any);
  }
  if (!partition && (paths || !planner)) {
    pi.on('before_agent_start', async event => {
      // Returning systemPrompt here would overwrite pi-trim's request-time edits.
      // Keep ordinary prompts structured so the upstream extension can trim them.
      const options = event.systemPromptOptions;
      if (paths) Object.assign(options, paths.view(options));
      // Normalize existing prompt paths only. Planner gets no extra addendum,
      // cwd announcement, environment hint or instruction to re-read files.
      if (planner) return;
      // Serial is the ordinary source-project Pi session. It has no path
      // adapter, so its prompt stays exactly as Pi and the project defined it.
      if (!graphNode && process.env.GRAPHER_MODE !== 'merger') return;
      if (process.env.GRAPHER_MODE === 'node' && process.env.GRAPHER_FEEDBACK_SOURCE === 'true') {
        // A custom rules section replaces Pi's generated rules, even when the
        // preamble is the default. Inject there rather than into guidelines
        // that Pi would discard. Forced prompts are opaque and need a block.
        if (options.forceSystemPrompt !== undefined) {
          options.forceSystemPrompt = `${options.forceSystemPrompt.trimEnd()}\n\n<rules>\n- ${FEEDBACK_RULE}\n</rules>`;
        } else if (options.customPrompt || options.sections?.rules) {
          const existing = options.sections.rules?.trimEnd();
          if (!existing?.includes(FEEDBACK_RULE)) {
            options.sections.rules = `${existing ? `${existing}\n` : ''}- ${FEEDBACK_RULE}`;
          }
        } else {
          options.promptGuidelines.push(FEEDBACK_RULE);
        }
      }
      // Extension-supplied rules replace Pi's defaults entirely. In that case
      // the request-time default-rule replacement has nothing to match.
      if (graphNode && !options.customPrompt && options.forceSystemPrompt === undefined && options.sections?.rules) {
        let rules = options.sections.rules.replace(
          /^- Show file paths clearly when working with files\r?$/gm, `- ${pathGuideline}`,
        );
        if (!rules.split(/\r?\n/).includes(`- ${pathGuideline}`)) {
          const existing = rules.trimEnd();
          rules = `${existing ? `${existing}\n` : ''}- ${pathGuideline}`;
        }
        options.sections.rules = rules;
      }
      const rawHints = process.env.GRAPHER_PREVIOUS_AGENT_ENVIRONMENT_HINTS?.trim();
      const hints = rawHints && paths ? paths.visible(rawHints) : rawHints;
      // Custom/forced prompts have no Pi rules section to replace. Preserve
      // their existing guidance behavior; default graph nodes need only hints.
      const useRules = graphNode && !options.customPrompt && options.forceSystemPrompt === undefined;
      const guidance = useRules ? hints : (hints ? `${pathGuideline}\n${hints}` : pathGuideline);
      if (!guidance) return;
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
  // retains its read/bash surface; write/edit are mounted only when enabled by
  // settings, and node/edge belong to the Planner extension.
  if (partition) return;
  if (graph && !project) throw new Error('Graph execution is missing its host-owned project binding');
  if (paths && project) {
    registerWorkspaceTools(pi, activePaths?.root || cwd, project, process.env.GRAPHER_SOURCE_ALIAS || project, view,
      planner ? (plannerWriteTools ? ['read', 'write', 'edit'] : ['read']) : undefined, () => activePaths?.root || cwd);

    // Normalize model-facing paths only; never change stored files, tool input
    // contents, provider signatures, or image bytes.
    pi.on('context', async event => ({ messages: view(event.messages) }));
    pi.on('tool_result', async event => ({ content: view(event.content), details: view(event.details) }));
    // Final assistant text is persisted/output after tool results. Normalize it
    // too, otherwise workspace spellings survive into the stored result and UI.
    pi.on('message_end', async event => event.message?.role === 'assistant'
      ? { message: view(event.message) } : undefined);
  }

  // Serial and Node Agent are distinct execution agents. Rust binds this identity
  // before factories run, including when a prepared host is claimed.
  const serialAgent = process.env.GRAPHER_AGENT_KIND === 'serial';
  const launch = managedLaunch();
  if (!serialAgent && (launch || graph)) {
    const localOps = createLocalBashOperations(launch ? { shellPath: launch.shell } : undefined);
    pi.on('user_bash', async () => ({ operations: {
      exec: (command, workingDirectory, options) => {
        const workspaceCwd = activePaths?.root || workingDirectory;
        return localOps.exec(
          managedBashCommand(activePaths ? activePaths.command(command) : command, workspaceCwd),
          workspaceCwd,
          managedBashOptions(options, managedShell),
        );
      },
    } }));
  }
  // Serial leaves Pi's default Bash definition and execution path untouched.
  if (!serialAgent) {
    const toolCallExitCodes = new Map<string, { exitCode: number | null; command: string; truncated?: boolean }>();
    const localOps = createLocalBashOperations(launch ? { shellPath: launch.shell } : undefined);
    const baseBashTool = createBashToolDefinition(cwd);
    pi.registerTool({
      ...baseBashTool,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        // Preserve native bash semantics. Callers can request errexit/pipefail
        // explicitly; injecting them changes otherwise valid shell programs.
        const rawCmd = params.command;

        let callExitCode: number | null = null;
        const scopedOps: BashOperations = {
          exec: async (command, cwd, options) => {
            const workspaceCwd = activePaths?.root || cwd;
            const res = await localOps.exec(
              managedBashCommand(command, workspaceCwd),
              workspaceCwd,
              managedBashOptions(options, managedShell),
            );
            callExitCode = res.exitCode;
            return res;
          },
        };

        const scopedBashTool = createBashToolDefinition(cwd, { operations: scopedOps });
        let result: any;
        let execError: any;
        try {
          const mapped = { ...params, command: activePaths ? activePaths.command(rawCmd) : rawCmd };
          const toolContext = activePaths && ctx ? { ...ctx, cwd: activePaths.root } : ctx;
          result = view(await scopedBashTool.execute(toolCallId, mapped, signal,
            onUpdate ? update => onUpdate(view(update)) : undefined, toolContext));
        } catch (err) {
          execError = err;
        }

        const exitCode = callExitCode;
        const isTruncated = !!(result?.details?.truncation?.truncated || result?.details?.truncated);
        toolCallExitCodes.set(toolCallId, { exitCode, command: rawCmd, truncated: isTruncated });

        if (execError) {
          if (execError instanceof Error && activePaths) execError.message = view(execError.message);
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
      if (event.toolName !== "bash") return;
      const recorded = toolCallExitCodes.get(event.toolCallId);
      if (recorded) toolCallExitCodes.delete(event.toolCallId);
      // Strictly preserve null when unknown; NEVER guess 0 without provenance
      const details = ((event.details || {}) as Record<string, unknown>);
      details.exitCode = recorded ? recorded.exitCode : null;
      details.command = recorded?.command ?? event.input?.command;
      details.truncated = recorded?.truncated ?? !!(details.truncation as any)?.truncated;
      return { details: view(details), isError: event.isError };
    });
  }
}
