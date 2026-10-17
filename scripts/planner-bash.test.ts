// The same Planner IO contract runs on macOS, Windows and Linux. Use pinned
// Pi tools through the production workspace policy, without model/provider calls.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBashToolDefinition } from '../engine/pi-compat.ts';
import workspacePolicy from '../engine/prompt-extension.ts';
import { loadExtensions } from '../pi/packages/coding-agent/src/core/extensions/loader.ts';
import { buildSystemPrompt, normalizeBuildSystemPromptOptions } from '../pi/packages/coding-agent/src/core/system-prompt.ts';
import { getShellConfig } from '../pi/packages/coding-agent/src/utils/shell.ts';

const root = resolve('.');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const shellPath = (value: string) => process.platform === 'win32' ? value.replaceAll('\\', '/') : value;
const text = (result: any) => result.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');

async function plannerTools(source: string, workspace = source) {
  const previous = process.cwd();
  const keys = ['GRAPHER_MODE', 'GRAPHER_EXECUTION_KIND', 'GRAPHER_ORIGINAL_ROOT', 'GRAPHER_SOURCE_ALIAS', 'GRAPHER_LAUNCH_BINDING'];
  const environment = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.chdir(workspace);
    Object.assign(process.env, { GRAPHER_MODE: 'planner', GRAPHER_EXECUTION_KIND: workspace === source ? 'source' : 'graph',
      GRAPHER_ORIGINAL_ROOT: source, GRAPHER_SOURCE_ALIAS: source });
    delete process.env.GRAPHER_LAUNCH_BINDING;
    const loaded = await loadExtensions([join(root, 'backend/resources/planner.ts')], workspace);
    assert.deepEqual(loaded.errors, []);
    const tools = new Map<string, any>([...loaded.extensions[0].tools].map(([name, tool]) => [name, tool.definition]));
    const hooks = new Map<string, any[]>();
    workspacePolicy({
      registerTool(tool: any) { assert.ok(!tools.has(tool.name), 'one owner per tool'); tools.set(tool.name, tool); },
      on(name: string, hook: any) { hooks.set(name, [...(hooks.get(name) ?? []), hook]); },
    } as any);
    assert.deepEqual([...tools.keys()].sort(), ['bash', 'edge', 'node', 'read']);
    return { tools, hooks, context: { cwd: workspace, sessionManager: { getSessionId: () => 'planner-test', getSessionFile: () => undefined } } as any };
  } finally {
    process.chdir(previous);
    for (const key of keys) {
      if (environment[key] === undefined) delete process.env[key]; else process.env[key] = environment[key];
    }
  }
}

test('Planner preserves native Bash semantics and immediate source writes on every platform', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grapher-planner-bash-'));
  const source = join(directory, '中文 space # %');
  try {
    await mkdir(source);
    const { tools, context } = await plannerTools(source);
    const planner = tools.get('bash');
    const builtin = createBashToolDefinition(source);
    if (process.platform === 'win32') {
      assert.match(getShellConfig().shell.replaceAll('\\', '/'), /\/Git\/bin\/bash\.exe$/i);
    }
    const cases = [
      ["values=(alpha beta); printf '%s ' \"${values[@]}\"", 'alpha beta'],
      ["printf 'b\\na\\n' | sort | tr '\\n' ','", 'a,b,'],
      ['value=$(printf substitution); printf %s "$value"', 'substitution'],
      ['(printf subshell)', 'subshell'],
      ['printf background > background.txt & child=$!; wait "$child"; cat background.txt', 'background'],
      ['bash -c \'sh -c "printf nested"\'', 'nested'],
      ['printf redirected > redirected.txt; cat < redirected.txt', 'redirected'],
      ['false | true; false; printf native', 'native'],
      ['printf stdout; printf stderr >&2', /stdout.*stderr|stderr.*stdout/s],
      [`${quote(shellPath(process.execPath))} -e 'process.stdout.write("node-ok")'`, 'node-ok'],
      ['git --version', /^git version /],
      ['rustc --version', /^rustc /],
      [`printf absolute > ${quote(shellPath(join(source, 'absolute.txt')))}; cat absolute.txt`, 'absolute'],
      ['mkdir -p nested; printf first > nested/file.txt; printf second >> nested/file.txt; cat nested/file.txt', 'firstsecond'],
      ['printf remove > deleted.txt; rm deleted.txt; test ! -e deleted.txt && printf removed', 'removed'],
    ] as const;
    for (const tool of [builtin, planner]) {
      for (const [command, expected] of cases) {
        const input = { command };
        const output = text(await tool.execute('bash-test', input, undefined, undefined, context)).trim();
        if (typeof expected === 'string') assert.equal(output, expected);
        else assert.match(output, expected);
        assert.equal(input.command, command, 'the caller input remains unchanged');
      }
      assert.equal(await readFile(join(source, 'absolute.txt'), 'utf8'), 'absolute');
      assert.equal(await readFile(join(source, 'nested/file.txt'), 'utf8'), 'firstsecond');
      const nonzero = await tool.execute('nonzero', { command: 'exit 7' }, undefined, undefined, context);
      assert.equal(nonzero.isError, true);
      assert.match(text(nonzero), /exited with code 7/);
      await assert.rejects(() => tool.execute('timeout', { command: 'sleep 2', timeout: 0.1 }, undefined, undefined, context), /timed out/i);
    }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
});

test('Planner keeps one visible path namespace across source, different worktrees and publication without prompt injection', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grapher-planner-paths-'));
  const source = join(directory, 'source 中文 space');
  const first = join(directory, 'first worktree'), second = join(directory, 'second worktree');
  try {
    for (const path of [source, first, second]) {
      await mkdir(path);
      await writeFile(join(path, 'value.txt'), path === source ? 'source' : path === first ? 'first' : 'second');
    }
    // Bind all turns, then execute after cwd/env have changed. A policy must
    // capture only its own current worktree, not reuse another turn's binding.
    const turns: Array<Awaited<ReturnType<typeof plannerTools>> & { workspace: string }> = [];
    for (const workspace of [source, first, second, source]) turns.push({ workspace, ...await plannerTools(source, workspace) });
    for (const { workspace, tools, hooks, context } of turns) {
      const expected = workspace === source ? 'source' : workspace === first ? 'first' : 'second';
      const bash = tools.get('bash'), read = tools.get('read');
      assert.equal(text(await bash.execute('pwd', { command: 'pwd -P' }, undefined, undefined, context)).trim(), '.');
      assert.equal(text(await read.execute('read-relative', { path: './value.txt' }, undefined, undefined, context)).trim(), expected);
      assert.equal(text(await read.execute('read-absolute', { path: join(source, 'value.txt') }, undefined, undefined, context)).trim(), expected);
      assert.equal(text(await bash.execute('bash-absolute', { command: `cat ${quote(shellPath(join(source, 'value.txt')))}` }, undefined, undefined, context)).trim(), expected);
      const updates: any[] = [];
      const result = await bash.execute('stream', { command: 'pwd -P' }, undefined, (update: any) => updates.push(update), context);
      assert.ok(updates.length);
      assert.ok(!JSON.stringify([result, updates]).includes(shellPath(workspace)));
      const encoded = `console.log(JSON.stringify({path:process.cwd(),uri:require('node:url').pathToFileURL(process.cwd()).href}))`;
      const output = JSON.parse(text(await bash.execute('encoded', { command: `${quote(shellPath(process.execPath))} -e ${quote(encoded)}` }, undefined, undefined, context)));
      assert.deepEqual(output, { path: '.', uri: pathToFileURL(source).href });
      const options = normalizeBuildSystemPromptOptions({ cwd: workspace, customPrompt: 'Planner system prompt.', appendSystemPrompt: 'Existing instructions.' });
      for (const hook of hooks.get('before_agent_start') ?? []) await hook({ systemPromptOptions: options });
      assert.equal(options.cwd, '.');
      assert.equal(options.customPrompt, 'Planner system prompt.');
      assert.equal(options.appendSystemPrompt, 'Existing instructions.');
      assert.equal(options.forceSystemPrompt, undefined);
      assert.ok(!buildSystemPrompt(options).includes(workspace), 'system prompt must not reveal the changing physical cwd');
      const user = { role: 'user', content: 'Continue the plan.' };
      const history = { role: 'toolResult', toolCallId: 'read-1', content: [{ type: 'text', text: join(workspace, 'value.txt') }] };
      const normalized = await hooks.get('context')![0]({ messages: [user, history] });
      assert.deepEqual(normalized.messages[0], user, 'no extra user instructions');
      assert.equal(normalized.messages[1].content[0].text.replaceAll('\\', '/'), './value.txt');
      await assert.rejects(() => read.execute('missing', { path: 'missing.txt' }, undefined, undefined, context),
        (error: Error) => !error.message.includes(workspace) && !error.message.includes(shellPath(workspace)));
    }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
});
