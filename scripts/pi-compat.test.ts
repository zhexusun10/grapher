import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { InMemoryCredentialStore } from '../pi/packages/ai/src/auth/credential-store.ts';
import { loadExtensions } from '../pi/packages/coding-agent/src/core/extensions/loader.ts';
import { bundledTrim, bundledContinuity } from '../engine/global-extensions.ts';
import { buildSystemPromptState } from '../pi/packages/coding-agent/src/core/system-prompt.ts';
import {
  ModelRuntime, SettingsManager, resolveToCwd,
  createBashToolDefinition, createLocalBashOperations,
  createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
  createLsToolDefinition, createFindToolDefinition, createGrepToolDefinition,
} from '../engine/pi-compat.ts';

for (const name of ['pi-trim', 'pi-continuity']) {
  test(`bundled ${name} matches the selected exact release, manifest and lock integrity`, () => {
    const installed = JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8'));
    const project = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
    const spec: string = project.dependencies[name];
    const pinned = lock.packages[`node_modules/${name}`];
    assert.equal(lock.packages[''].dependencies[name], spec);
    assert.equal(pinned.version, installed.version);
    assert.deepEqual(installed.pi.extensions, ['./extensions/index.ts'], 'Review the launcher if the upstream entrypoint changes');
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

test('bundled pi-trim replaces Grapher prompt trimming', async () => {
  const prompt = [
    'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files.',
    '<rules>\n- Be concise\n</rules>',
    '<docs>\nPi documentation (read only when the user asks about Pi): /path/to/pi/docs\n- Read it when asked about Pi\n</docs>',
    '<cwd>\n/workspace\n</cwd>',
  ].join('\n');
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
});

test('pi-trim handles Pi 1.0 prompt sections and mid-turn updates without altering tools, project context or stored messages', async () => {
  const identity = 'You are an expert coding assistant operating inside pi, a coding agent harness.';
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
  const loaded = await loadExtensions([bundledTrim], process.cwd());
  assert.deepEqual(loaded.errors, []);
  const hook = loaded.extensions[0].handlers.get('context_with_system')![0];
  const result = await hook({ type: 'context_with_system', messages } as any, {} as any) as any;
  assert.deepEqual(messages, snapshot, 'request-time trimming must not mutate stored transcript data');
  assert.equal(result.messages[0].sections.docs, null);
  assert.match(result.messages[0].sections.preamble, /^You are an expert coding assistant\./);
  assert.ok(!result.messages[0].sections.rules.includes(environmentRule));
  for (const name of ['tools', 'project_context', 'skills', 'mcp_servers', 'cwd', 'addendum']) {
    assert.equal(result.messages[0].sections[name], state.sections![name], `preserve ${name}`);
  }
  const delta = result.messages[3];
  assert.equal(delta.sections.docs, null);
  assert.equal(delta.sections.obsolete, null);
  assert.equal(delta.content[0].text, 'You are an expert coding assistant.');
  assert.deepEqual(delta.content[0].cacheControl, { type: 'ephemeral' });
  assert.match(delta.sections.rules, /Keep task instructions/);
  assert.ok(!delta.sections.rules.includes(environmentRule));
  for (const index of [0, 3]) {
    assert.strictEqual(result.messages[index].toolsAdded, messages[index].toolsAdded);
    assert.strictEqual(result.messages[index].toolsRemoved, messages[index].toolsRemoved);
  }
  for (const index of [1, 2, 4]) assert.strictEqual(result.messages[index], messages[index]);
  assert.equal(await hook({ type: 'context_with_system', messages: result.messages } as any, {} as any), undefined, 'trimming is idempotent');
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
    ls: createLsToolDefinition, find: createFindToolDefinition,
    grep: createGrepToolDefinition,
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
  ]) {
    assert.equal(runtime.getModel(provider, id), undefined, `${provider}/${id}: saved selections need replacement`);
  }
});
