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
import { AgentSession, ExtensionRunner, ModelRuntime, SessionManager, SettingsManager, DefaultPackageManager,
  createEditToolDefinition as piEditTool, getAgentDir } from '../pi/packages/coding-agent/src/index.ts';
import { Agent } from '../pi/packages/agent/src/index.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { stripJsonComments } from '../pi/packages/coding-agent/src/utils/json.ts';
import { ModelConfig } from '../pi/packages/coding-agent/src/core/model-config.ts';
import { overlayRuntimeOptions } from './model-config-overlay.mjs';
import { join } from 'node:path';
import { existsSync, lstatSync, readFileSync, readdirSync, mkdirSync, openSync, readSync, writeFileSync, closeSync } from 'node:fs';
import { migrateKeybindingsConfig } from '../pi/packages/coding-agent/src/core/keybindings.ts';
import { resolvePath as resolvePiPath } from '../pi/packages/coding-agent/src/utils/paths.ts';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { withInheritedSearchCredentials } from './search-credentials.mjs';
import { samePath } from './path-identity.mjs';

const bundledTrimPath = fileURLToPath(new URL('../node_modules/pi-trim/extensions/index.ts', import.meta.url));
const PI_TRIM_MODE_ENTRY = 'pi-trim-mode';
const DEFAULT_GRAPHER_TRIM_ENTRY = Object.freeze({
  type: 'custom',
  customType: PI_TRIM_MODE_ENTRY,
  data: { mode: 'aggressive' },
});

function hasSavedTrimMode() {
  const path = join(getAgentDir(), 'pi-trim.json');
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as { mode?: unknown };
    return parsed?.mode === 'default' || parsed?.mode === 'aggressive';
  } catch {
    return false;
  }
}

function withAggressiveTrimDefault(sessionManager: any) {
  if (!sessionManager || typeof sessionManager.getBranch !== 'function') return sessionManager;
  return new Proxy(sessionManager, {
    get(target, prop) {
      if (prop === 'getBranch') {
        return (...branchArgs: unknown[]) => {
          const branch = target.getBranch(...branchArgs);
          if (branchArgs.length > 0 || !Array.isArray(branch)) return branch;
          if (hasSavedTrimMode() || branch.some((entry: any) =>
            entry?.type === 'custom' && entry?.customType === PI_TRIM_MODE_ENTRY &&
            (entry?.data?.mode === 'default' || entry?.data?.mode === 'aggressive'))) {
            return branch;
          }
          return [DEFAULT_GRAPHER_TRIM_ENTRY, ...branch];
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const wrappedTrimHandlers = new WeakSet<Function>();

// Grapher defaults bundled pi-trim to aggressive mode (<tools> summary stripped
// while preserving tool schemas and <rules>) without mutating session files on
// startup; explicit /pi-trim mode entries on the branch still take precedence.
export function installDefaultAggressiveTrim() {
  const runnerPrototype = ExtensionRunner.prototype as any;
  const emit = runnerPrototype.emit;
  const wrappedHandlers = new WeakMap<Function, Function>();
  runnerPrototype.emit = function (this: any, event: { type?: string }, ...args: any[]) {
    if (event?.type === 'session_start' || event?.type === 'session_tree') {
      for (const ext of this.extensions ?? []) {
        const extPath = ext?.resolvedPath ?? ext?.path;
        if (typeof extPath !== 'string' || !samePath(extPath, bundledTrimPath)) continue;
        const handlers = ext.handlers?.get?.(event.type);
        if (!Array.isArray(handlers)) continue;
        for (let i = 0; i < handlers.length; i++) {
          const original = handlers[i];
          if (wrappedTrimHandlers.has(original)) continue;
          let wrapped = wrappedHandlers.get(original);
          if (!wrapped) {
            wrapped = (ev: unknown, ctx: any) => {
              if (!ctx?.sessionManager) return original(ev, ctx);
              const wrappedCtx = Object.defineProperties({}, {
                ...Object.getOwnPropertyDescriptors(ctx),
                sessionManager: {
                  enumerable: true,
                  configurable: true,
                  get() { return withAggressiveTrimDefault(ctx.sessionManager); },
                },
              });
              return original(ev, wrappedCtx);
            };
            wrappedHandlers.set(original, wrapped);
            wrappedTrimHandlers.add(wrapped);
          }
          handlers[i] = wrapped;
        }
      }
    }
    return emit.call(this, event, ...args);
  };
  return () => {
    runnerPrototype.emit = emit;
  };
}

const parseModels = (content: string) => JSON.parse(stripJsonComments(content.replace(/^\uFEFF/, '')));
export function modelRuntimeOptions(options: Parameters<typeof ModelRuntime.create>[0] = {}) {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.grapher', 'pi-agent');
  return overlayRuntimeOptions(options, agentDir, parseModels, async (path: string) => !(await ModelConfig.load(path)).getError());
}
export async function loadBundledWebSearch() {
  // Reuse Pi's loader and SDK modules for the one bundled compatibility shim.
  const [{ createJiti }, { VIRTUAL_MODULES }] = await Promise.all([
    import('../pi/packages/coding-agent/src/core/extensions/jiti-loader.ts'),
    import('../pi/packages/coding-agent/src/core/extensions/virtual-modules.ts'),
  ]);
  const credentialPath = fileURLToPath(new URL('../node_modules/pi-better-web-search/lib/credentials.ts', import.meta.url));
  const loader = createJiti(import.meta.url, { moduleCache: false, virtualModules: VIRTUAL_MODULES, tsconfigPaths: true });
  const credentials = withInheritedSearchCredentials(await loader.import(credentialPath));
  // This relative module belongs only to this package-local loader. Other
  // user extensions keep their own imports and credential implementations.
  const jiti = createJiti(import.meta.url, { moduleCache: false,
    virtualModules: { ...VIRTUAL_MODULES, './credentials.ts': credentials }, tsconfigPaths: true });
  return jiti.import<import('../pi/packages/coding-agent/src/index.ts').ExtensionFactory>(
    fileURLToPath(new URL('../node_modules/pi-better-web-search/extensions/index.ts', import.meta.url)), { default: true });
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
export async function runPiCommandCli(args: string[], options: MainOptions = {}) {
  const needsSession = () => { throw new Error('This operation requires an active conversation.'); };
  const prompt = AgentSession.prototype.prompt;
  const restore: Array<() => void> = [];
  AgentSession.prototype.prompt = function (text, promptOptions) {
    const name = /^\/([^\s]+)/.exec(text)?.[1];
    if (!name || !this.extensionRunner.getCommand(name)) return Promise.reject(new Error('Only registered extension commands can run without a conversation.'));
    return prompt.call(this, text, promptOptions);
  };
  // Commands can manage configuration and credentials. They cannot create a
  // conversation, compact nonexistent history, or start an inference request.
  for (const [prototype, names] of [
    [AgentSession.prototype, ['compact', 'newSession', 'fork', 'navigateTree', 'switchSession']],
    [ModelRuntime.prototype, ['stream', 'streamSimple', 'complete', 'classify', 'generateImages']],
  ] as const) {
    for (const name of names) {
      const object = prototype as unknown as Record<string, unknown>;
      const original = object[name];
      if (typeof original !== 'function') continue;
      object[name] = needsSession;
      restore.push(() => { object[name] = original; });
    }
  }
  try { await runPiCli(args, options); }
  finally { AgentSession.prototype.prompt = prompt; for (const reset of restore) reset(); }
}

export const GRAPHER_SESSION_FORMAT = 1;

// Keep the current edits normalization, but never fold retired top-level edits
// into a second replacement, even when a valid edits array was also supplied.
export function createEditToolDefinition(...args: Parameters<typeof piEditTool>) {
  const tool = piEditTool(...args);
  return { ...tool, prepareArguments(input: unknown) {
    if (input && typeof input === 'object' && ('oldText' in input || 'newText' in input)) {
      throw new Error('Unsupported edit input: use path and edits[]');
    }
    return tool.prepareArguments ? tool.prepareArguments(input) : input;
  } };
}

export function assertCurrentPiSettings(settings: Record<string, any>) {
  if (['queueMode', 'websockets', 'apiKeys'].some(key => key in settings) ||
      (settings.skills !== null && typeof settings.skills === 'object' && !Array.isArray(settings.skills)) ||
      (settings.retry && typeof settings.retry === 'object' && 'maxDelayMs' in settings.retry)) {
    throw new Error('Unsupported Pi settings format; update settings explicitly before using Grapher');
  }
}

// Run before Pi's CLI or resource loading. These inputs would otherwise be
// renamed, rewritten or removed by upstream startup migrations.
export function assertCurrentPiDirectories(cwd: string, agentDir: string, projectTrusted = true) {
  cwd = resolvePiPath(cwd);
  agentDir = resolvePiPath(agentDir);
  for (const [directory, readSettings] of [[agentDir, true], [join(cwd, '.pi'), projectTrusted]] as const) {
    // Startup moves commands regardless of project trust. Settings only become
    // input when the SDK is allowed to load their scope.
    if (existsSync(join(directory, 'commands'))) throw new Error('Unsupported Pi commands directory; use prompts/');
    const settings = join(directory, 'settings.json');
    if (readSettings && existsSync(settings)) assertCurrentPiSettings(JSON.parse(readFileSync(settings, 'utf8').replace(/^\uFEFF/, '')));
  }
  if (existsSync(agentDir)) for (const name of readdirSync(agentDir).filter(name => name.endsWith('.jsonl'))) {
    let value;
    try { value = readPiHeader(join(agentDir, name), Infinity).header; }
    catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code) continue;
      throw error;
    }
    if (value?.type === 'session' && value.cwd) {
      throw new Error('Unsupported Pi sessions in agent root; use a new agent directory');
    }
  }
  if (!existsSync(join(agentDir, 'auth.json')) && existsSync(join(agentDir, 'oauth.json'))) {
    throw new Error('Unsupported Pi oauth.json; configure auth.json explicitly');
  }
  if (['fd', 'rg', 'fd.exe', 'rg.exe'].some(name => existsSync(join(agentDir, 'tools', name)))) {
    throw new Error('Unsupported Pi tools directory; configure bin/ explicitly');
  }
  const keybindings = join(agentDir, 'keybindings.json');
  if (existsSync(keybindings)) {
    const config = JSON.parse(readFileSync(keybindings, 'utf8').replace(/^\uFEFF/, ''));
    if (config && typeof config === 'object' && !Array.isArray(config) && migrateKeybindingsConfig(config).migrated) {
      throw new Error('Unsupported Pi keybinding names; use current names');
    }
  }
}

export function assertCurrentSessionHeader(header: any) {
  if (header?.type !== 'session' || header.version !== 3 || header.grapherFormat !== GRAPHER_SESSION_FORMAT) {
    throw new Error('Unsupported Grapher Pi session format');
  }
  const run = process.env.GRAPHER_ACTIVE_RUN_ID;
  if (run && header.grapherRunId !== run) throw new Error('Pi session belongs to another Grapher Run');
}

function markNewSession(manager: SessionManager) {
  const header = manager.getHeader();
  if (header?.type !== 'session' || header.version !== 3) throw new Error('Unsupported Grapher Pi session format');
  Object.assign(header, { grapherFormat: GRAPHER_SESSION_FORMAT,
    grapherRunId: process.env.GRAPHER_ACTIVE_RUN_ID ?? null });
}

function readPiHeader(path: string, limit = 1024 * 1024): { header: any; complete: boolean } {
  const fd = openSync(path, 'r');
  try {
    const chunks: Buffer[] = [];
    let count = 0;
    while (count < limit) {
      const bytes = Buffer.alloc(Math.min(64 * 1024, limit - count));
      const size = readSync(fd, bytes, 0, bytes.length, count);
      if (!size) break;
      const newline = bytes.subarray(0, size).indexOf(10);
      chunks.push(bytes.subarray(0, newline < 0 ? size : newline));
      count += size;
      if (newline >= 0) return { header: JSON.parse(Buffer.concat(chunks).toString('utf8')), complete: true };
    }
    if (!count) return { header: null, complete: false };
    if (count === limit) throw new Error('Unsupported Grapher Pi session header');
    return { header: JSON.parse(Buffer.concat(chunks).toString('utf8')), complete: false };
  } finally { closeSync(fd); }
}

export function assertCurrentSessionFile(path: string) {
  const { header, complete } = readPiHeader(path);
  if (!complete) throw new Error('Unsupported Grapher Pi session header');
  assertCurrentSessionHeader(header);
}

// These private touchpoints are deliberately confined to the pinned binding.
// Guard every SDK load, including continue/fork/setSessionFile and RPC switching,
// before upstream's _loadEntries can migrate and rewrite the original file.
const openSession = SessionManager.open;
SessionManager.open = function (path, ...args) {
  const resolved = resolvePiPath(path);
  if (existsSync(resolved)) assertCurrentSessionFile(resolved);
  // The SDK constructor can create sessionDir before _setSessionFile runs.
  return openSession.call(this, resolved, ...args);
};
const sessionPrototype = SessionManager.prototype as any;
const setSessionFile = sessionPrototype._setSessionFile;
sessionPrototype._setSessionFile = function (path: string, ...args: any[]) {
  const resolved = resolvePiPath(path);
  if (existsSync(resolved)) assertCurrentSessionFile(resolved);
  return setSessionFile.call(this, resolved, ...args);
};
const loadEntries = sessionPrototype._loadEntries;
sessionPrototype._loadEntries = function (entries: any[], ...args: any[]) {
  const header = entries.find(entry => entry.type === 'session');
  // Current SDK callers may restore a headerless entry tree in memory. That
  // path creates a fresh header and never invokes file/version migration.
  if (this.persist || header) assertCurrentSessionHeader(this.persist ? entries[0] : header);
  return loadEntries.call(this, entries, ...args);
};
const newSession = SessionManager.prototype.newSession;
SessionManager.prototype.newSession = function (...args) {
  const result = newSession.apply(this, args);
  markNewSession(this);
  return result;
};
const createBranchedSession = sessionPrototype.createBranchedSession;
sessionPrototype.createBranchedSession = function (...args: any[]) {
  assertCurrentSessionHeader(this.getHeader());
  const ownRewrite = Object.getOwnPropertyDescriptor(this, '_rewriteFile');
  const rewrite = this._rewriteFile;
  // This synchronous SDK operation constructs a fresh header itself. Tag that
  // header before its first write, without changing the SDK's branch algorithm.
  this._rewriteFile = function (...writeArgs: any[]) {
    markNewSession(this);
    return rewrite.apply(this, writeArgs);
  };
  try {
    const result = createBranchedSession.apply(this, args);
    markNewSession(this); // In-memory and not-yet-flushed branches do not rewrite.
    return result;
  } finally {
    if (ownRewrite) Object.defineProperty(this, '_rewriteFile', ownRewrite);
    else delete this._rewriteFile;
  }
};
SessionManager.forkFrom = function (source, cwd, directory, options) {
  // Validate before upstream can create a target file. Seed the current header
  // ourselves because upstream forkFrom constructs an unmarked Pi-only header.
  const original = SessionManager.open(source);
  assertCurrentSessionHeader(original.getHeader());
  const target = SessionManager.create(cwd, directory, options);
  const header = target.getHeader()!;
  header.parentSession = resolvePiPath(source);
  const path = target.getSessionFile()!;
  mkdirSync(target.getSessionDir(), { recursive: true });
  const fd = openSync(path, 'wx');
  try {
    writeFileSync(fd, `${JSON.stringify(header)}\n`);
    for (const entry of original.getEntries()) writeFileSync(fd, `${JSON.stringify(entry)}\n`);
  } finally { closeSync(fd); }
  return SessionManager.open(path, target.getSessionDir());
};

const piSettings = SettingsManager as any;
const migrateSettings = piSettings.migrateSettings;
piSettings.migrateSettings = function (settings: Record<string, any>) {
  assertCurrentPiSettings(settings);
  return migrateSettings.call(this, settings);
};
const createSettings = SettingsManager.create;
SettingsManager.create = function (cwd, agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.grapher', 'pi-agent'), ...args) {
  assertCurrentPiDirectories(cwd, agentDir, args[0]?.projectTrusted !== false);
  return createSettings.call(this, cwd, agentDir, ...args);
};
const packagePrototype = DefaultPackageManager.prototype as any;
packagePrototype.getNpmInstallPath = function (source: unknown, scope: unknown) {
  return this.getManagedNpmInstallPath(source, scope);
};

export async function runPiCli(args: string[], options: MainOptions = {}) {
  assertCurrentPiDirectories(process.cwd(), process.env.PI_CODING_AGENT_DIR || join(homedir(), '.grapher', 'pi-agent'));
  const [{ setupCli }, { main }] = await preparePiCli();
  setupCli();
  // Pi's CLI creates its own runtime. Retarget its default models path while
  // retaining the original auth and models-store locations.
  const create = ModelRuntime.create;
  const restoreQueueIdentity = installQueueIdentity();
  const restoreDefaultAggressiveTrim = installDefaultAggressiveTrim();
  ModelRuntime.create = async (runtimeOptions = {}) => create.call(ModelRuntime, await modelRuntimeOptions(runtimeOptions));
  try { await main(args, options); }
  finally {
    ModelRuntime.create = create;
    restoreDefaultAggressiveTrim();
    restoreQueueIdentity();
  }
}
