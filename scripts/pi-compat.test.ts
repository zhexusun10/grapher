import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { SessionManager } from '../pi/packages/coding-agent/src/core/session-manager.ts';
import { ExtensionRunner } from '../pi/packages/coding-agent/src/core/extensions/runner.ts';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, relative, isAbsolute } from 'node:path';
import { Agent } from '../pi/packages/agent/src/index.ts';
import { InMemoryCredentialStore } from '../pi/packages/ai/src/auth/credential-store.ts';
import { loadExtensions } from '../pi/packages/coding-agent/src/core/extensions/loader.ts';
import { bundledTrim, bundledContinuity, bundledWebSearch } from '../engine/global-extensions.ts';
import { buildSystemPromptState } from '../pi/packages/coding-agent/src/core/system-prompt.ts';
import {
  ModelRuntime, SettingsManager, resolveToCwd, getModelThinkingCapabilities, composerCommandsExtension, clearUnreadQueue,
  createBashToolDefinition, createLocalBashOperations,
  createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
  assertCurrentPiDirectories, assertCurrentPiSettings, DefaultPackageManager, installDefaultAggressiveTrim,
} from '../engine/pi-compat.ts';

test('retired Pi sessions are rejected before migration and current sessions retain Run identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'grapher-session-format-'));
  const previous = process.env.GRAPHER_ACTIVE_RUN_ID;
  process.env.GRAPHER_ACTIVE_RUN_ID = '11111111-1111-4111-8111-111111111111';
  try {
    for (const version of [undefined, 1, 2, 3, 4]) {
      const path = join(root, `old-${version}.jsonl`);
      const bytes = `${JSON.stringify({ type: 'session', version, id: 'old', cwd: root })}\n`;
      writeFileSync(path, bytes);
      assert.throws(() => SessionManager.open(path), /Unsupported Grapher Pi session/);
      const openDirectory = join(root, `open-${version}`);
      assert.throws(() => SessionManager.open(path, openDirectory), /Unsupported Grapher Pi session/);
      assert.equal(existsSync(openDirectory), false, 'opening a rejected file must not create its target directory');
      assert.throws(() => SessionManager.forkFrom(path, root, join(root, 'forbidden')), /Unsupported Grapher Pi session/);
      assert.equal(readFileSync(path, 'utf8'), bytes);
      assert.equal(existsSync(join(root, 'forbidden')), false, 'reject before creating a fork directory');
    }
    const current = SessionManager.create(root, join(root, 'current'));
    current.appendMessage({ role: 'user', content: 'same input', timestamp: 1 });
    const path = current.getSessionFile()!;
    const bytes = readFileSync(path, 'utf8');
    const reopened = SessionManager.open(path);
    assert.equal((reopened.getHeader() as any).grapherFormat, 1);
    const forked = SessionManager.forkFrom(path, root, join(root, 'forked'));
    assert.deepEqual(forked.getEntries(), reopened.getEntries());
    assert.equal((forked.getHeader() as any).grapherRunId, process.env.GRAPHER_ACTIVE_RUN_ID);
    assert.equal(readFileSync(path, 'utf8'), bytes, 'fork leaves the source append history untouched');
    process.env.GRAPHER_ACTIVE_RUN_ID = '22222222-2222-4222-8222-222222222222';
    assert.throws(() => SessionManager.open(path), /another Grapher Run/);
    assert.equal(readFileSync(path, 'utf8'), bytes);
  } finally {
    if (previous === undefined) delete process.env.GRAPHER_ACTIVE_RUN_ID;
    else process.env.GRAPHER_ACTIVE_RUN_ID = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('Pi settings and startup directories reject retired inputs without changing their bytes', () => {
  for (const settings of [{ queueMode: 'all' }, { websockets: true }, { skills: { customDirectories: [] } },
    { retry: { maxDelayMs: 1 } }, { apiKeys: { example: 'fixture' } }]) {
    const before = structuredClone(settings);
    assert.throws(() => assertCurrentPiSettings(settings), /Unsupported Pi settings/);
    assert.throws(() => SettingsManager.inMemory(settings as any), /Unsupported Pi settings/);
    assert.deepEqual(settings, before);
  }
  const root = mkdtempSync(join(tmpdir(), 'grapher-pi-format-'));
  try {
    for (const relative of ['commands/prompt.md', 'tools/rg', 'old.jsonl', 'oauth.json', 'keybindings.json', 'settings.json']) {
      const agent = join(root, relative.replaceAll('/', '-'));
      const path = join(agent, relative);
      mkdirSync(join(path, '..'), { recursive: true });
      const bytes = relative === 'keybindings.json' ? '{"cursorUp":"up"}'
        : relative === 'settings.json' ? '{"queueMode":"all"}'
        : relative === 'old.jsonl' ? '{"type":"session","cwd":"/old"}\n' : '{}';
      writeFileSync(path, bytes);
      assert.throws(() => assertCurrentPiDirectories(root, agent), /Unsupported Pi/);
      assert.equal(readFileSync(path, 'utf8'), bytes);
      assert.equal(existsSync(join(agent, 'prompts')), false);
      assert.equal(existsSync(join(agent, 'auth.json')), false);
    }
    const cleanAgent = join(root, 'clean-agent');
    mkdirSync(cleanAgent);
    writeFileSync(join(cleanAgent, 'extension-log.jsonl'), '{"type":"extension_log"}\n');
    writeFileSync(join(cleanAgent, 'large-extension-log.jsonl'), JSON.stringify({ type: 'extension_log', text: 'x'.repeat(1024 * 1024) }) + '\n');
    assert.doesNotThrow(() => assertCurrentPiDirectories(root, cleanAgent), 'unrelated extension logs are not old sessions');
    const project = join(root, 'project');
    mkdirSync(join(project, '.pi/commands'), { recursive: true });
    assert.throws(() => assertCurrentPiDirectories(project, join(root, 'clean-agent')), /commands directory/);
    assert.equal(existsSync(join(project, '.pi/commands')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('current in-memory entry lists retain their tree without requiring a persisted header', () => {
  const source = SessionManager.inMemory();
  source.appendMessage({ role: 'user', content: 'current input', timestamp: 1 });
  const entries = structuredClone(source.getEntries());
  const restored = SessionManager.inMemory(process.cwd(), { id: 'memory-copy' }, entries);
  assert.deepEqual(restored.getEntries(), entries);
  assert.equal(restored.getLeafId(), source.getLeafId());
  assert.equal(restored.getSessionId(), 'memory-copy');
  assert.equal(restored.isPersisted(), false);
  assert.equal(restored.getSessionFile(), undefined);
  assert.equal((restored.getHeader() as any).grapherFormat, 1);
  assert.throws(() => SessionManager.inMemory(process.cwd(), undefined,
    [...entries, { type: 'session', version: 2 } as any]), /Unsupported Grapher Pi session/);
  assert.deepEqual(source.getEntries(), entries);
});

test('Pi directory checks use the same path spelling rules as the SDK', () => {
  const root = mkdtempSync(join(tmpdir(), 'grapher-pi-path-format-'));
  try {
    const agent = join(root, 'agent');
    mkdirSync(join(agent, 'commands'), { recursive: true });
    writeFileSync(join(agent, 'commands/prompt.md'), 'keep');
    const spellings = [pathToFileURL(agent).href];
    const homeRelative = relative(homedir(), agent);
    if (!isAbsolute(homeRelative)) spellings.push(`~/${homeRelative.replaceAll('\\', '/')}`);
    for (const spelling of spellings) assert.throws(() => assertCurrentPiDirectories(root, spelling), /commands directory/);
    const project = join(root, 'project');
    mkdirSync(join(project, '.pi/commands'), { recursive: true });
    assert.throws(() => assertCurrentPiDirectories(pathToFileURL(project).href, join(root, 'clean-agent')), /commands directory/);
    assert.equal(readFileSync(join(agent, 'commands/prompt.md'), 'utf8'), 'keep');
    assert.equal(existsSync(join(agent, 'prompts')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('global settings discovery leaves untrusted project settings unread', () => {
  const root = mkdtempSync(join(tmpdir(), 'grapher-pi-project-trust-'));
  try {
    mkdirSync(join(root, '.pi'));
    const path = join(root, '.pi/settings.json'), bytes = '{"queueMode":"all"}\n';
    writeFileSync(path, bytes);
    const settings = SettingsManager.create(root, join(root, 'agent'), { projectTrusted: false });
    assert.deepEqual(settings.getProjectSettings(), {});
    assert.throws(() => SettingsManager.create(root, join(root, 'agent'), { projectTrusted: true }), /Unsupported Pi settings/);
    assert.equal(readFileSync(path, 'utf8'), bytes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('SDK branch extraction keeps current ownership, labels and a reopenable file', () => {
  const root = mkdtempSync(join(tmpdir(), 'grapher-pi-branch-format-'));
  const previous = process.env.GRAPHER_ACTIVE_RUN_ID;
  process.env.GRAPHER_ACTIVE_RUN_ID = '11111111-1111-4111-8111-111111111111';
  try {
    for (const persisted of [true, false]) {
      const session = persisted ? SessionManager.create(root, join(root, 'sessions')) : SessionManager.inMemory(root);
      const first = session.appendMessage({ role: 'user', content: 'first', timestamp: 1 });
      session.appendLabelChange(first, 'anchor');
      const second = session.appendMessage({ role: 'user', content: 'second', timestamp: 2 });
      const originalPath = session.getSessionFile();
      const original = originalPath ? readFileSync(originalPath, 'utf8') : undefined;
      const rewrite = Object.getOwnPropertyDescriptor(session, '_rewriteFile');
      assert.throws(() => session.createBranchedSession('missing-entry'), /not found/);
      assert.deepEqual(Object.getOwnPropertyDescriptor(session, '_rewriteFile'), rewrite);
      const path = session.createBranchedSession(second);
      assert.equal((session.getHeader() as any).grapherFormat, 1);
      assert.equal((session.getHeader() as any).grapherRunId, process.env.GRAPHER_ACTIVE_RUN_ID);
      assert.equal(session.getEntry(second)?.parentId, first, 'removing label entries must preserve the branch chain');
      assert.equal(session.getTree().length, 1);
      assert.ok(session.getEntries().some(entry => entry.type === 'label' && entry.label === 'anchor'));
      if (persisted) {
        assert.ok(path);
        assert.deepEqual(SessionManager.open(path).getEntries(), session.getEntries());
        assert.equal(readFileSync(originalPath!, 'utf8'), original);
      } else assert.equal(path, undefined);
    }
    const unflushed = SessionManager.create(root, join(root, 'deferred'));
    const model = unflushed.appendModelChange('test', 'model');
    unflushed.appendMessage({ role: 'user', content: 'source conversation', timestamp: 1 });
    const path = unflushed.createBranchedSession(model)!;
    assert.equal(existsSync(path), false, 'a branch without messages stays unflushed');
    unflushed.appendMessage({ role: 'user', content: 'first branch input', timestamp: 2 });
    assert.equal((SessionManager.open(path).getHeader() as any).grapherRunId, process.env.GRAPHER_ACTIVE_RUN_ID);
  } finally {
    if (previous === undefined) delete process.env.GRAPHER_ACTIVE_RUN_ID;
    else process.env.GRAPHER_ACTIVE_RUN_ID = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('edit rejects retired top-level replacements while keeping current collection normalization', () => {
  const tool = createEditToolDefinition(process.cwd());
  for (const input of [{ path: 'file', oldText: 'a', newText: 'b' },
    { path: 'file', edits: [{ oldText: 'a', newText: 'b' }], oldText: 'c', newText: 'd' }]) {
    const before = structuredClone(input);
    assert.throws(() => tool.prepareArguments(input), /Unsupported edit input/);
    assert.deepEqual(input, before);
  }
  for (const edits of ['[{"oldText":"a","newText":"b"}]', { oldText: 'a', newText: 'b' }]) {
    assert.deepEqual(tool.prepareArguments({ path: 'file', edits }), { path: 'file', edits: [{ oldText: 'a', newText: 'b' }] });
  }
});

test('package resolution uses managed installs even when a retired global resolver is available', () => {
  const manager = new DefaultPackageManager({ cwd: process.cwd(), agentDir: process.cwd(), settingsManager: SettingsManager.inMemory() }) as any;
  manager.getLegacyGlobalNpmInstallPath = () => assert.fail('must never query npm/pnpm global installations');
  const path = manager.getNpmInstallPath({ name: 'fixture-package' }, 'user');
  assert.equal(path, join(process.cwd(), 'npm/node_modules/fixture-package'));
});

test('queue recall excludes drained-but-not-yet-rendered turns and preserves queue modes', () => {
  const agent = new Agent({ streamFn: () => { throw new Error('no model calls'); } });
  const message = (text: string) => ({ role: 'user' as const, content: [{ type: 'text' as const, text }], timestamp: 0 });
  const clearDisplay = () => {
    agent.clearAllQueues();
    // Pi retains this display entry while prepareNextTurn/compaction awaits,
    // although the Agent already owns it outside the removable queue.
    return { steering: ['already drained', 'same', 'same'], followUp: ['later'] };
  };
  agent.steer(message('same'));
  agent.steer(message('same'));
  agent.followUp(message('later'));
  assert.deepEqual(clearUnreadQueue(agent, clearDisplay), { steering: ['same', 'same'], followUp: ['later'] });
  assert.equal(agent.steeringMode, 'one-at-a-time');
  assert.equal(agent.followUpMode, 'one-at-a-time');
  assert.equal(agent.hasQueuedMessages(), false);
  assert.deepEqual(clearUnreadQueue(agent, clearDisplay), { steering: [], followUp: [] },
    'the display list alone is never proof of removal');
  agent.steeringMode = 'all';
  agent.followUpMode = 'all';
  agent.followUp(message('follow-up only'));
  assert.deepEqual(clearUnreadQueue(agent, clearDisplay), { steering: [], followUp: ['follow-up only'] });
  assert.equal(agent.steeringMode, 'all');
  assert.equal(agent.followUpMode, 'all');
  const control = { role: 'custom' as const, customType: 'extension-control', content: 'keep guidance', display: false, timestamp: 0 };
  agent.steer(control);
  agent.steer(message('remove user text'));
  assert.deepEqual(clearUnreadQueue(agent, clearDisplay), { steering: ['remove user text'], followUp: [] });
  assert.deepEqual(agent.peekQueuedMessages(), [control], 'extension-owned guidance must not be silently removed');
});

test('composer reload delegates to Pi command context after the current turn is idle', async () => {
  let handler: any;
  let sessionStart: any;
  await composerCommandsExtension.factory({ on(event: string, callback: any) {
    assert.equal(event, 'session_start'); sessionStart = callback;
  }, registerCommand(name: string, command: any) {
    if (name === 'reload') handler = command.handler;
  } } as any);
  const notices: string[] = [];
  const ctx = { mode: 'rpc', ui: { notify: (message: string) => notices.push(message), custom: async () => undefined } };
  sessionStart({}, ctx);
  await ctx.ui.custom();
  assert.match(notices[0], /terminal-only custom UI/);
  const calls: string[] = [];
  await handler('', { waitForIdle: async () => { calls.push('idle'); }, reload: async () => { calls.push('reload'); } });
  assert.deepEqual(calls, ['idle', 'reload']);
});

test('composer compact waits for idle and callback completion without aborting the current turn', async () => {
  let handler: any;
  await composerCommandsExtension.factory({ on() {}, registerCommand(name: string, command: any) {
    if (name === 'compact') handler = command.handler;
  } } as any);
  let idle!: () => void;
  const idleBoundary = new Promise<void>(resolve => { idle = resolve; });
  let options: any;
  let settled = false;
  const command = handler(' keep tests\nand failures ', {
    waitForIdle: () => idleBoundary,
    compact: (value: any) => { options = value; },
    abort: () => assert.fail('compaction must not abort the active turn'),
  }).then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(options, undefined, 'do not call Pi compact until the active turn settles');
  idle();
  await Promise.resolve();
  assert.equal(options.customInstructions, 'keep tests\nand failures');
  assert.equal(settled, false, 'the callback, not the void SDK return, ends the RPC command');
  options.onComplete({ summary: 'done' });
  await command;
  assert.equal(settled, true);
  await assert.rejects(handler('', {
    waitForIdle: async () => {},
    compact: (value: any) => value.onError(new Error('compaction failed')),
  }), /compaction failed/);
});

test('bundled extension peer providers match the reviewed Pi baseline', () => {
  const project = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const baseline = JSON.parse(readFileSync(new URL('../engine/pi-lock.json', import.meta.url), 'utf8'));
  for (const name of ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent']) {
    const installed = JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8'));
    assert.equal(project.dependencies[name], baseline.packageVersion, `${name} must track the source baseline`);
    assert.equal(lock.packages[`node_modules/${name}`].version, baseline.packageVersion);
    assert.equal(installed.version, baseline.packageVersion);
  }
});

for (const [name, entry] of [
  ['pi-trim', './extensions/index.ts'],
  ['pi-continuity', './extensions/index.ts'],
  ['pi-better-web-search', './extensions/index.ts'],
]) {
  test(`bundled ${name} matches the selected exact release, manifest and lock integrity`, () => {
    const installed = JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8'));
    const project = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
    const spec: string = project.dependencies[name];
    const pinned = lock.packages[`node_modules/${name}`];
    assert.equal(lock.packages[''].dependencies[name], spec);
    assert.equal(pinned.version, installed.version);
    assert.deepEqual(installed.pi.extensions, [entry], 'Review the launcher if the upstream entrypoint changes');
    assert.deepEqual(Object.keys(installed.dependencies ?? {}), [], 'Graph copies bundled packages without peers; review new runtime dependencies before upgrading');
    assert.match(pinned.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
    assert.equal(spec, installed.version, 'Registry updates must pin an exact release, not latest or a version range');
    assert.equal(pinned.resolved, `https://registry.npmjs.org/${name}/-/${name}-${installed.version}.tgz`);
  });
}

test('bundled continuity loads against the pinned Pi public boundary API', async () => {
  const loaded = await loadExtensions([bundledContinuity], process.cwd());
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  for (const event of ['session_start', 'turn_end', 'agent_before_settle', 'agent_settled', 'context']) {
    assert.ok(extension.handlers.has(event), `${event}: recovery boundary registered`);
  }
  assert.ok(extension.commands.has('pi-continuity'));
  assert.ok(extension.flags.has('continuity'));
});

test('bundled web search loads its provider-native tool against the pinned Pi public boundary API', async () => {
  const loaded = await loadExtensions([bundledWebSearch], process.cwd());
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  assert.ok(extension.tools.has('web_search'));
  for (const event of ['session_start', 'session_tree', 'model_select', 'before_agent_start']) {
    assert.ok(extension.handlers.has(event), `${event}: dynamic exposure boundary registered`);
  }
});

test('bundled pi-trim replaces Grapher prompt trimming', async () => {
  const prompt = [
    'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files.',
    '<rules>\n- Be concise\n</rules>',
    '<docs>\nPi documentation (read only when the user asks about Pi): /path/to/pi/docs\n- Read it when asked about Pi\n</docs>',
    '<cwd>\n/workspace\n</cwd>',
  ].join('\n');
  const trimAgentDir = mkdtempSync(join(tmpdir(), 'grapher-pi-trim-compat-'));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = trimAgentDir;
  try {
    const loaded = await loadExtensions([bundledTrim], process.cwd());
    assert.deepEqual(loaded.errors, []);
    const hook = loaded.extensions[0].handlers.get('context_with_system')![0];
    const result = await hook({ messages: [{ role: 'system', content: prompt }] } as any, {} as any) as any;
    const sanitized = result.messages[0].content;
    assert.match(sanitized, /^You are an expert coding assistant\. You help users/);
    assert.match(sanitized, /<rules>[\s\S]*<\/rules>/);
    assert.doesNotMatch(sanitized, /operating inside pi, a coding agent harness/);
    assert.doesNotMatch(sanitized, /<docs>|Pi documentation|\/path\/to\/pi\/docs/);
    assert.match(sanitized, /<cwd>[\s\S]*<\/cwd>/);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(trimAgentDir, { recursive: true, force: true });
  }
});

test('pi-trim handles Pi 1.5 prompt sections and mid-turn updates without altering tools, project context or stored messages', async () => {
  const identity = 'You are a coding assistant running inside pi, a coding agent harness.';
  const environmentRule = '- You can inspect PI_* environment variables for current model and session details.';
  const projectText = `${identity}\n<docs>\nPi documentation (read only for this project)\n</docs>\n${environmentRule}`;
  const state = buildSystemPromptState({
    cwd: '/workspace', selectedTools: ['read', 'bash'], toolSnippets: { read: 'Read files', bash: 'Run commands' },
    promptGuidelines: [environmentRule.slice(2)], appendSystemPrompt: 'Preserve valid changes. Do not modify unrelated files.',
    contextFiles: [{ path: 'AGENTS.md', content: projectText }],
    sections: { skills: projectText, mcp_servers: 'Keep MCP guidance intact' },
  });
  const tool = { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } };
  const messages = [
    { role: 'system', ...state, toolsAdded: [tool], timestamp: 1 },
    { role: 'user', content: projectText, timestamp: 2 },
    { role: 'assistant', content: [{ type: 'text', text: projectText }], timestamp: 3 },
    { role: 'system', content: [{ type: 'text', text: identity, cacheControl: { type: 'ephemeral' } }], timestamp: 4,
      sections: { docs: state.sections!.docs, rules: `<rules>\n${environmentRule}\n- Keep task instructions\n</rules>`, obsolete: null },
      toolsAdded: [tool], toolsRemoved: [{ name: 'bash' }] },
    { role: 'toolResult', toolCallId: 'read-1', toolName: 'read', content: [{ type: 'text', text: projectText }], timestamp: 5 },
  ];
  const snapshot = structuredClone(messages);
  const trimAgentDir = mkdtempSync(join(tmpdir(), 'grapher-pi-trim-agent-'));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = trimAgentDir;
  try {
    const loaded = await loadExtensions([bundledTrim], process.cwd());
    assert.deepEqual(loaded.errors, []);
    const hook = loaded.extensions[0].handlers.get('context_with_system')![0];
    const result = await hook({ type: 'context_with_system', messages } as any, {} as any) as any;
    assert.deepEqual(messages, snapshot, 'request-time trimming must not mutate stored transcript data');
    assert.equal(result.messages[0].sections.docs, null);
    assert.match(result.messages[0].sections.preamble, /^You are a coding assistant\./);
    assert.ok(!result.messages[0].sections.rules.includes(environmentRule));
    for (const name of ['tools', 'project_context', 'skills', 'mcp_servers', 'cwd', 'addendum']) {
      assert.equal(result.messages[0].sections[name], state.sections![name], `preserve ${name}`);
    }
    const delta = result.messages[3];
    assert.equal(delta.sections.docs, null);
    assert.equal(delta.sections.obsolete, null);
    assert.equal(delta.content[0].text, 'You are a coding assistant.');
    assert.deepEqual(delta.content[0].cacheControl, { type: 'ephemeral' });
    assert.match(delta.sections.rules, /Keep task instructions/);
    assert.ok(!delta.sections.rules.includes(environmentRule));
    for (const index of [0, 3]) {
      assert.strictEqual(result.messages[index].toolsAdded, messages[index].toolsAdded);
      assert.strictEqual(result.messages[index].toolsRemoved, messages[index].toolsRemoved);
    }
    for (const index of [1, 2, 4]) assert.strictEqual(result.messages[index], messages[index]);
    assert.equal(await hook({ type: 'context_with_system', messages: result.messages } as any, {} as any), undefined, 'trimming is idempotent');

    const command = loaded.extensions[0].commands.get('pi-trim');
    assert.ok(command, 'pi-trim command registered');
    const persisted: Array<{ type: string; customType: string; data: unknown }> = [];
    loaded.runtime.appendEntry = (customType, data) => { persisted.push({ type: 'custom', customType, data }); };
    const notices: string[] = [];
    await command.handler('mode aggressive', { hasUI: true, ui: { notify: (msg: string) => notices.push(msg) }, getSystemPrompt: () => '' } as any);
    assert.match(notices.at(-1) ?? '', /mode set to aggressive/);
    assert.deepEqual(persisted, [{ type: 'custom', customType: 'pi-trim-mode', data: { mode: 'aggressive' } }]);
    const aggressiveResult = await hook({ type: 'context_with_system', messages } as any, {} as any) as any;
    assert.equal(aggressiveResult.messages[0].sections.tools, null);
    assert.equal(aggressiveResult.messages[0].sections.docs, null);
    assert.equal(aggressiveResult.messages[0].sections.rules, result.messages[0].sections.rules);
    assert.strictEqual(aggressiveResult.messages[0].toolsAdded, messages[0].toolsAdded);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(trimAgentDir, { recursive: true, force: true });
  }
});

test('installDefaultAggressiveTrim defaults bundled pi-trim without double-wrapping or masking saved settings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grapher-trim-default-'));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const restore = installDefaultAggressiveTrim();
  try {
    const loaded = await loadExtensions([bundledTrim], process.cwd());
    assert.deepEqual(loaded.errors, []);
    const ext = loaded.extensions[0];
    const startHandlers = ext.handlers.get('session_start')!;
    const treeHandlers = ext.handlers.get('session_tree')!;
    let lazyReads = 0;
    const baseSessionManager = {
      branch: [] as unknown[],
      getBranch(...args: unknown[]) { return args.length ? [] : this.branch; },
    };
    const errors: unknown[] = [];
    const fakeRunner = Object.assign(Object.create(ExtensionRunner.prototype), {
      extensions: [ext],
      emitError(err: unknown) { errors.push(err); },
      createContext() {
        return {
          get ui() { lazyReads += 1; return undefined; },
          get sessionManager() { return baseSessionManager; },
        };
      },
    });

    // Calling emit multiple times must not double-wrap handlers or eagerly read lazy getters.
    await ExtensionRunner.prototype.emit.call(fakeRunner, { type: 'session_start', reason: 'startup' } as any);
    const wrappedStart = startHandlers[0];
    await ExtensionRunner.prototype.emit.call(fakeRunner, { type: 'session_start', reason: 'reload' } as any);
    assert.strictEqual(startHandlers[0], wrappedStart);
    await ExtensionRunner.prototype.emit.call(fakeRunner, { type: 'session_tree', previousSessionFile: undefined } as any);
    const wrappedTree = treeHandlers[0];
    await ExtensionRunner.prototype.emit.call(fakeRunner, { type: 'session_tree', previousSessionFile: undefined } as any);
    assert.strictEqual(treeHandlers[0], wrappedTree);
    assert.equal(lazyReads, 0, 'wrapping context must preserve lazy ExtensionContext getters');
    assert.deepEqual(errors, []);

    const state = buildSystemPromptState({
      cwd: '/workspace', selectedTools: ['read'], toolSnippets: { read: 'Read files' },
    });
    const hook = ext.handlers.get('context_with_system')![0];
    const aggressive = await hook({ type: 'context_with_system', messages: [{ role: 'system', ...state, timestamp: 1 }] } as any, {} as any) as any;
    assert.equal(aggressive.messages[0].sections.tools, null, 'default aggressive strips <tools>');

    // Malformed branch entry does not suppress aggressive default; valid branch entry wins.
    baseSessionManager.branch = [{ type: 'custom', customType: 'pi-trim-mode', data: { mode: 'invalid' } }];
    await ExtensionRunner.prototype.emit.call(fakeRunner, { type: 'session_tree', previousSessionFile: undefined } as any);
    const stillAggressive = await hook({ type: 'context_with_system', messages: [{ role: 'system', ...state, timestamp: 1 }] } as any, {} as any) as any;
    assert.equal(stillAggressive.messages[0].sections.tools, null);

    baseSessionManager.branch = [{ type: 'custom', customType: 'pi-trim-mode', data: { mode: 'default' } }];
    await ExtensionRunner.prototype.emit.call(fakeRunner, { type: 'session_tree', previousSessionFile: undefined } as any);
    const branchDefault = await hook({ type: 'context_with_system', messages: [{ role: 'system', ...state, timestamp: 1 }] } as any, {} as any) as any;
    assert.equal(branchDefault.messages[0].sections.tools, state.sections!.tools);

    // Symlinked pi-trim.json is ignored by pi-trim and must not suppress the aggressive default.
    baseSessionManager.branch = [];
    const targetFile = join(dir, 'target.json');
    writeFileSync(targetFile, JSON.stringify({ mode: 'default' }));
    try { symlinkSync(targetFile, join(dir, 'pi-trim.json')); } catch { /* ignore on restricted Windows */ }
    await ExtensionRunner.prototype.emit.call(fakeRunner, { type: 'session_tree', previousSessionFile: undefined } as any);
    const symlinkIgnored = await hook({ type: 'context_with_system', messages: [{ role: 'system', ...state, timestamp: 1 }] } as any, {} as any) as any;
    assert.equal(symlinkIgnored.messages[0].sections.tools, null);
  } finally {
    restore();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Pi SDK surface required by Grapher remains available', () => {
  assert.equal(typeof ModelRuntime.create, 'function');
  assert.equal(typeof SettingsManager.inMemory, 'function');
  const cwd = process.cwd();
  assert.equal(resolveToCwd('file.txt', cwd), join(cwd, 'file.txt'));
  assert.equal(typeof createLocalBashOperations().exec, 'function');
  for (const [name, factory] of Object.entries({
    bash: createBashToolDefinition, read: createReadToolDefinition,
    write: createWriteToolDefinition, edit: createEditToolDefinition,
  })) {
    const tool = factory(cwd);
    assert.equal(tool.name, name);
    assert.equal(typeof tool.execute, 'function');
    assert.ok(tool.parameters, `${name} must expose its input schema`);
  }
  // This private upstream entrypoint is invoked only after the host retry
  // policy is installed; importing it in a test would start the CLI.
  accessSync(fileURLToPath(new URL('../pi/packages/coding-agent/src/cli.ts', import.meta.url)));
});

test('model thinking capabilities follow Pi reasoning flags, sparse maps and clamping', async () => {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const base = runtime.getModel('azure', 'gpt-4o-mini')!;
  const offOnly = getModelThinkingCapabilities({ ...base, reasoning: false });
  assert.deepEqual(offOnly.thinkingLevels, ['off']);
  assert.deepEqual(offOnly.thinkingLevelFallbacks, { minimal: 'off', low: 'off', medium: 'off', high: 'off', xhigh: 'off', max: 'off' });
  assert.deepEqual(getModelThinkingCapabilities({ ...base, reasoning: true, thinkingLevelMap: undefined }), {
    thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high'], thinkingLevelFallbacks: { xhigh: 'high', max: 'high' },
  });
  const restricted = getModelThinkingCapabilities({ ...base, reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' } });
  assert.deepEqual(restricted, {
    thinkingLevels: ['low', 'high', 'max'], thinkingLevelFallbacks: { off: 'low', minimal: 'low', medium: 'high', xhigh: 'max' },
  });
  const fixed = getModelThinkingCapabilities({ ...base, reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: null } });
  assert.deepEqual(fixed.thinkingLevels, ['high']);
  assert.equal(fixed.thinkingLevelFallbacks.off, 'high');
  assert.equal(fixed.thinkingLevelFallbacks.max, 'high');
  const extended = getModelThinkingCapabilities({ ...base, reasoning: true, thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } });
  assert.deepEqual(extended.thinkingLevels, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(extended.thinkingLevelFallbacks, {});
});

test('Azure provider rename requires credential migration while preserving its environment variable and API ids', async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify('azure-openai-responses', async () => ({ type: 'api_key', key: 'legacy-test-key' }));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
  assert.deepEqual(runtime.getModels('azure-openai-responses'), [], 'no implicit legacy provider alias');
  assert.equal(runtime.getModel('azure', 'gpt-4o-mini')?.api, 'azure-openai-responses');
  assert.equal(runtime.getModel('azure', 'deepseek-v4-pro')?.api, 'openai-completions');
  assert.equal(await runtime.getAuth('azure', { env: { AZURE_OPENAI_API_KEY: '' } }), undefined,
    'credentials stored under the old provider id do not authenticate the renamed provider');
  const fromEnv = await runtime.getAuth('azure', { env: { AZURE_OPENAI_API_KEY: 'env-test-key' } });
  assert.equal(fromEnv?.auth.apiKey, 'env-test-key');
  await credentials.modify('azure', async () => ({ type: 'api_key', key: 'migrated-test-key' }));
  const migrated = await runtime.getAuth('azure', { env: { AZURE_OPENAI_API_KEY: '' } });
  assert.equal(migrated?.auth.apiKey, 'migrated-test-key');
  assert.deepEqual(await credentials.read('azure-openai-responses'), { type: 'api_key', key: 'legacy-test-key' },
    'upgrading must not rewrite user credentials');
});

test('refreshed catalog exposes reviewed API changes and does not resurrect retired models', async () => {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  for (const id of ['qwen3.7-plus', 'qwen3.8-max']) {
    assert.equal(runtime.getModel('opencode-go', id)?.api, 'anthropic-messages', `opencode-go/${id}`);
  }
  for (const [provider, id] of [
    ['openrouter', 'qwen/qwen3.8-27b:free'],
    ['openrouter', 'stealth/space-bunny-alpha'],
    ['vercel-ai-gateway', 'inclusionai/ling-3.0-flash-sante-free'],
    // Retired while moving to the Pi 1.2.0 snapshot; the Vertex `*-latest`
    // aliases moved to concrete ids.
    ['openrouter', 'inclusionai/ling-3.0-flash-sante:free'],
    ['opencode', 'fledge-alpha-free'],
    ['google-vertex', 'gemini-flash-latest'],
    ['google-vertex', 'gemini-flash-lite-latest'],
    // Retired while moving to the Pi 1.3.0 snapshot: OpenRouter dropped both the
    // free and the paid `*-sante` Ling variants, and the OpenCode Zen catalog
    // shrank; the plain Ling models and `opencode-go/step-5-preview` remain.
    ['openrouter', 'inclusionai/ling-3.0-flash-sante'],
    ['opencode', 'step-5-preview-free'],
    // Retired while moving to the Pi 1.4.0 snapshot: Copilot dropped `gpt-5.4`
    // (its default is now `gpt-6.1-sol`), Codex dropped the models that always
    // fail for ChatGPT accounts, and the older `chat-latest` aliases are gone.
    ['github-copilot', 'gpt-5.4'],
    ['openai-codex', 'gpt-5.5'],
    ['openai-codex', 'gpt-5.3-codex-spark'],
    ['azure', 'gpt-5.2-chat-latest'],
    ['openai', 'gpt-5.3-chat-latest'],
    // Retired while moving to the Pi 1.5.0 snapshot: the OpenCode Go Gemini
    // contributor slot moved to the direct `gemini-4-argon` id, the free
    // minimax/longcat previews and several legacy OpenRouter models disappeared.
    ['opencode-go', 'gemini-4-argon-contributor'],
    ['opencode-go', 'minimax-m3.1-flash-free'],
    ['opencode', 'deepseek-v4-flash'],
    ['openrouter', 'openai/gpt-4-turbo'],
    ['google-vertex', 'gemini-3.1-flash-lite-image'],
  ]) {
    assert.equal(runtime.getModel(provider, id), undefined, `${provider}/${id}: saved selections need replacement`);
  }
  assert.equal(runtime.getModel('openrouter', 'inclusionai/ling-3.0-flash')?.api, 'openai-completions');
  // OpenCode Go moved to the opencode.ai inference endpoints in 1.3.0 and gained
  // Google Generative AI support, while its Qwen models stay on Anthropic Messages.
  assert.equal(runtime.getModel('opencode-go', 'gemini-4-argon')?.api, 'google-generative-ai');
  assert.match(runtime.getModel('opencode-go', 'gemini-4-argon')?.baseUrl ?? '', /^https:\/\/opencode\.ai\/inference\/go\/google\/v1beta$/);
  // OpenRouter router models report a negative placeholder price; the snapshot must use 0, not -$1,000,000.
  assert.deepEqual(runtime.getModel('openrouter', 'openrouter/auto')?.cost,
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  // Pi 1.4.0 replaces Copilot's retired default, adds MiniMax-M3.1-Flash with
  // thinking levels through `max`, and gives Grok 4.3 the `xhigh` level.
  assert.equal(runtime.getModel('github-copilot', 'gpt-6.1-sol')?.api, 'openai-responses');
  const miniMax = runtime.getModel('minimax', 'MiniMax-M3.1-Flash');
  assert.deepEqual(getModelThinkingCapabilities(miniMax!).thinkingLevels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.ok(getModelThinkingCapabilities(runtime.getModel('xai', 'grok-4.3')!).thinkingLevels.includes('xhigh'));
  // Pi 1.5.0 adds the direct OpenCode Go Gemini endpoint and the GPT-6.1
  // Terra/Grok 4.7 catalog entries while keeping the provider APIs stable.
  assert.equal(runtime.getModel('opencode-go', 'minimax-m3.1-flash')?.api, 'openai-completions');
  assert.equal(runtime.getModel('openai', 'gpt-6.1-terra')?.api, 'openai-responses');
  assert.equal(runtime.getModel('xai', 'grok-4.7')?.api, 'openai-responses');
});
