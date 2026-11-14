// Grapher's only source-level Pi binding. Keep upstream paths and API
// assumptions here so a Pi upgrade can be reviewed and contract-tested in one place.
// Use Pi's public SDK exports for the production tool/provider surface.
export {
  ModelRuntime,
  SettingsManager,
  DefaultPackageManager,
  createMcpExtension,
  createBashToolDefinition,
  createLocalBashOperations,
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
} from '../pi/packages/coding-agent/src/index.ts';
export type { ExtensionAPI, BashOperations } from '../pi/packages/coding-agent/src/index.ts';

export { obj, opt, str } from '../pi/packages/schema/src/index.ts';
import { contentText, clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from '../pi/packages/ai/src/index.ts';

// This is the protocol vocabulary, not a list of levels every model supports.
const thinkingLevels: ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export function getModelThinkingCapabilities(model: Model<Api>) {
  const supported = getSupportedThinkingLevels(model);
  const fallbacks: Partial<Record<ModelThinkingLevel, ModelThinkingLevel>> = {};
  for (const level of thinkingLevels) {
    if (!supported.includes(level)) fallbacks[level] = clampThinkingLevel(model, level);
  }
  return { thinkingLevels: supported, thinkingLevelFallbacks: fallbacks };
}

// Private path, MCP-config and CLI-setup touchpoints remain centralized here.
export { loadMcpConfig } from '../pi/packages/coding-agent/src/extensions/mcp/config.ts';
export type { LoadedMcpConfig, McpServerEntry } from '../pi/packages/coding-agent/src/index.ts';
export { validateMcpServerConfig } from '../pi/packages/coding-agent/src/core/mcp-servers.ts';
export { mcpNamespace } from '../pi/packages/mcp/src/index.ts';
export { CONFIG_DIR_NAME } from '../pi/packages/coding-agent/src/config.ts';
export { resolveToCwd } from '../pi/packages/coding-agent/src/core/tools/path-utils.ts';
import type { MainOptions, InlineExtension } from '../pi/packages/coding-agent/src/index.ts';
import { AgentSession, ModelRuntime } from '../pi/packages/coding-agent/src/index.ts';
import { Agent } from '../pi/packages/agent/src/index.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { stripJsonComments } from '../pi/packages/coding-agent/src/utils/json.ts';
import { ModelConfig } from '../pi/packages/coding-agent/src/core/model-config.ts';
import { overlayRuntimeOptions } from './model-config-overlay.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const parseModels = (content: string) => JSON.parse(stripJsonComments(content.replace(/^\uFEFF/, '')));
export function modelRuntimeOptions(options: Parameters<typeof ModelRuntime.create>[0] = {}) {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.grapher', 'pi-agent');
  return overlayRuntimeOptions(options, agentDir, parseModels, async (path: string) => !(await ModelConfig.load(path)).getError());
}
export type { InlineExtension } from '../pi/packages/coding-agent/src/index.ts';
// RPC does not dispatch interactive-mode builtins. Delegate command actions
// through the SDK, keeping their idle/settle boundaries inside Pi.
export const composerCommandsExtension: InlineExtension = {
  name: 'grapher-composer-commands',
  factory: pi => {
    pi.on('session_start', (_event, ctx) => {
      if (ctx.mode !== 'rpc') return;
      // Pi's RPC custom() otherwise returns undefined silently. Arbitrary TUI
      // factories cannot run in a browser; make that limitation visible.
      ctx.ui.custom = async () => {
        ctx.ui.notify('This extension requires a terminal-only custom UI. Use its text commands or subcommands in Grapher.', 'warning');
        return undefined as never;
      };
    });
    pi.registerCommand('reload', {
      description: 'Reload Pi extensions, skills, prompts and context files',
      handler: async (_args, ctx) => { await ctx.waitForIdle(); await ctx.reload(); },
    });
    pi.registerCommand('compact', {
      description: 'Compact the session context after the current turn finishes',
      handler: async (args, ctx) => {
        // The raw compact RPC aborts the current agent turn. Keep the command
        // pending while waiting, then through compaction's callback completion.
        await ctx.waitForIdle();
        await new Promise<void>((resolve, reject) => ctx.compact({
          customInstructions: args.trim() || undefined,
          onComplete: () => resolve(),
          onError: reject,
        }));
      },
    });
  },
};
// Pi's display lists include turns already drained into prepareNextTurn (for
// example while compaction awaits). clearQueue cannot recall those turns. Take
// the actual public Agent queues synchronously, before clearing the display
// lists, and return only messages that were still removable.
export function clearUnreadQueue(agent: AgentSession['agent'], clearDisplayQueue: () => unknown, identities?: WeakMap<object, string>) {
  const steeringMode = agent.steeringMode;
  const followUpMode = agent.followUpMode;
  try {
    agent.steeringMode = 'all';
    agent.followUpMode = 'all';
    const first = agent.peekQueuedMessages();
    agent.clearSteeringQueue();
    const followUp = agent.peekQueuedMessages();
    const followUpSet = new Set(followUp);
    const steering = first.filter(message => !followUpSet.has(message));
    clearDisplayQueue();
    // Alt+Q recalls user input, not extension-owned control/context messages.
    for (const message of steering) if (message.role !== 'user') agent.steer(message);
    for (const message of followUp) if (message.role !== 'user') agent.followUp(message);
    const text = (messages: typeof first) => messages.filter(message => message.role === 'user')
      .map(message => contentText(message.content, ''));
    const result = { steering: text(steering), followUp: text(followUp) };
    if (!identities) return result;
    // Identity lives on the queued object, separately from the text that input
    // hooks/templates are allowed to rewrite. Never infer it from equal text.
    return { ...result, messages: [...steering, ...followUp].filter(message => message.role === 'user').map(message => ({
      requestId: identities.get(message), text: contentText(message.content, ''),
      images: Array.isArray(message.content) ? message.content.filter(part => part.type === 'image') : [],
    })) };
  } finally {
    agent.steeringMode = steeringMode;
    agent.followUpMode = followUpMode;
  }
}

// The private Node envelope is removed before slash parsing or extension input
// hooks. Async-local scope follows only that submission through async rewriting;
// nested, unmarked extension submissions explicitly start an unowned scope.
export function installQueueIdentity() {
  const context = new AsyncLocalStorage<{ agent: Agent; requestId: string; claimed: boolean; active: boolean } | undefined>();
  const identities = new WeakMap<object, string>();
  const deferredInputs = new WeakMap<object, { agent: Agent; requestId: string; text: string }>();
  const marker = /\n\n<grapher-(node-|)steer-id>([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})<\/grapher-\1steer-id>$/;
  const wrap = <T extends (this: AgentSession, text: string, ...args: any[]) => Promise<any>>(original: T, mayDefer = false): T => function (this: AgentSession, text: string, ...args: any[]) {
    // Pi defers prompt(text, options) during agent_settled and calls prompt
    // again after the first promise returns. Carry identity on its private
    // options object, without decoding already-cleaned user text a second time.
    const saved = mayDefer && args[0] && typeof args[0] === 'object' ? deferredInputs.get(args[0]) : undefined;
    const carried = saved?.agent === this.agent && saved.text === text ? saved : undefined;
    const source = mayDefer ? args[0]?.source : args[1]?.source;
    // Only the RPC boundary owns the envelope. Extension/interactive input may
    // legitimately quote marker-shaped text and must never gain its identity.
    const match = !carried && source === 'rpc' ? marker.exec(text) : null;
    const requestId = carried?.requestId ?? match?.[2];
    const scope = requestId ? { agent: this.agent, requestId, claimed: false, active: true } : undefined;
    // Planner's existing marker also proves transcript consumption. Preserve
    // it for that protocol; Node/Merger identity never enters the transcript.
    const input = match?.[1] ? text.slice(0, match.index) : text;
    if (mayDefer && requestId) {
      const options = { ...args[0] };
      deferredInputs.set(options, { agent: this.agent, requestId, text: input });
      args[0] = options;
    }
    return context.run(scope, () => original.call(this, input, ...args))
      .finally(() => { if (scope) scope.active = false; });
  } as T;
  const prompt = AgentSession.prototype.prompt;
  const sessionSteer = AgentSession.prototype.steer;
  const sessionFollowUp = AgentSession.prototype.followUp;
  const steer = Agent.prototype.steer;
  const followUp = Agent.prototype.followUp;
  const clearQueue = AgentSession.prototype.clearQueue;
  const identify = (agent: Agent, message: Parameters<Agent['steer']>[0]) => {
    const scope = context.getStore();
    if (scope?.active && !scope.claimed && scope.agent === agent && message.role === 'user') {
      identities.set(message, scope.requestId);
      scope.claimed = true;
    }
  };
  AgentSession.prototype.prompt = wrap(prompt, true);
  AgentSession.prototype.steer = wrap(sessionSteer);
  AgentSession.prototype.followUp = wrap(sessionFollowUp);
  Agent.prototype.steer = function (message) { identify(this, message); steer.call(this, message); };
  Agent.prototype.followUp = function (message) { identify(this, message); followUp.call(this, message); };
  AgentSession.prototype.clearQueue = function () { return clearUnreadQueue(this.agent, () => clearQueue.call(this), identities); };
  return () => {
    AgentSession.prototype.prompt = prompt;
    AgentSession.prototype.steer = sessionSteer;
    AgentSession.prototype.followUp = sessionFollowUp;
    Agent.prototype.steer = steer;
    Agent.prototype.followUp = followUp;
    AgentSession.prototype.clearQueue = clearQueue;
  };
}

let preparedCli: Promise<[typeof import('../pi/packages/coding-agent/src/cli/setup.ts'), typeof import('../pi/packages/coding-agent/src/index.ts')]> | undefined;
// Import/code preparation only: no resources, extensions, sessions or model calls.
export function preparePiCli() {
  return preparedCli ??= Promise.all([
    import('../pi/packages/coding-agent/src/cli/setup.ts'),
    import('../pi/packages/coding-agent/src/index.ts'),
  ]);
}
export async function runPiCli(args: string[], options: MainOptions = {}) {
  const [{ setupCli }, { main }] = await preparePiCli();
  setupCli();
  // Pi's CLI creates its own runtime. Retarget its default models path while
  // retaining the original auth and models-store locations.
  const create = ModelRuntime.create;
  const restoreQueueIdentity = installQueueIdentity();
  ModelRuntime.create = async (runtimeOptions = {}) => create.call(ModelRuntime, await modelRuntimeOptions(runtimeOptions));
  try { await main(args, options); }
  finally {
    ModelRuntime.create = create;
    restoreQueueIdentity();
  }
}
