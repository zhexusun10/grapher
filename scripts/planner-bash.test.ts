// The same Planner IO contract runs on macOS, Windows and Linux. Use pinned
// Pi tools through the production workspace policy, without model/provider calls.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBashToolDefinition } from '../engine/pi-compat.ts';
import { scrubModelShellEnvironment } from '../engine/launch-binding.mjs';
import workspacePolicy from '../engine/prompt-extension.ts';
import { loadExtensions } from '../pi/packages/coding-agent/src/core/extensions/loader.ts';
import { buildSystemPrompt, normalizeBuildSystemPromptOptions } from '../pi/packages/coding-agent/src/core/system-prompt.ts';
import { getShellConfig } from '../pi/packages/coding-agent/src/utils/shell.ts';

const root = resolve('.');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const shellPath = (value: string) => process.platform === 'win32' ? value.replaceAll('\\', '/') : value;
const text = (result: any) => result.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');

async function plannerTools(source: string, workspace = source, writeTools = true) {
  const previous = process.cwd();
  const keys = ['GRAPHER_MODE', 'GRAPHER_EXECUTION_KIND', 'GRAPHER_ORIGINAL_ROOT', 'GRAPHER_SOURCE_ALIAS', 'GRAPHER_LAUNCH_BINDING', 'GRAPHER_PLANNER_WRITE_TOOLS'];
  const environment = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.chdir(workspace);
    // Production Pi reports process.cwd() (realpath'd on macOS, as-launched on
    // Windows); capture that exact spelling for prompt/history inputs.
    const boundCwd = process.cwd();
    Object.assign(process.env, { GRAPHER_MODE: 'planner', GRAPHER_EXECUTION_KIND: workspace === source ? 'source' : 'graph',
      GRAPHER_ORIGINAL_ROOT: source, GRAPHER_SOURCE_ALIAS: source, GRAPHER_PLANNER_WRITE_TOOLS: String(writeTools) });
    delete process.env.GRAPHER_LAUNCH_BINDING;
    const loaded = await loadExtensions([join(root, 'backend/resources/planner.ts')], workspace);
    assert.deepEqual(loaded.errors, []);
    const tools = new Map<string, any>([...loaded.extensions[0].tools].map(([name, tool]) => [name, tool.definition]));
    const hooks = new Map<string, any[]>();
    workspacePolicy({
      registerTool(tool: any) { assert.ok(!tools.has(tool.name), 'one owner per tool'); tools.set(tool.name, tool); },
      on(name: string, hook: any) { hooks.set(name, [...(hooks.get(name) ?? []), hook]); },
    } as any);
    assert.deepEqual([...tools.keys()].sort(), writeTools
      ? ['bash', 'edge', 'edit', 'node', 'read', 'write']
      : ['bash', 'edge', 'node', 'read'], 'the setting controls only write/edit mounting');
    // ctx.cwd mirrors what production Pi passes to tools: its own process.cwd().
    return { boundCwd, tools, hooks, context: { cwd: boundCwd, sessionManager: { getSessionId: () => 'planner-test', getSessionFile: () => undefined } } as any };
  } finally {
    process.chdir(previous);
    for (const key of keys) {
      if (environment[key] === undefined) delete process.env[key]; else process.env[key] = environment[key];
    }
  }
}

test('Planner can withhold write and edit tools while retaining read and Bash', { timeout: 30_000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'grapher-planner-files-')));
  try {
    await writeFile(join(directory, 'plan.txt'), 'read-only');
    const { tools, context } = await plannerTools(directory, directory, false);
    assert.equal(tools.has('write'), false);
    assert.equal(tools.has('edit'), false);
    assert.equal(text(await tools.get('read').execute('read', { path: './plan.txt' }, undefined, undefined, context)).trim(), 'read-only');
    assert.equal(text(await tools.get('bash').execute('bash', { command: 'printf ready' }, undefined, undefined, context)).trim(), 'ready');
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
});

test('Planner preserves native Bash semantics and immediate source writes on every platform', { timeout: 30_000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'grapher-planner-bash-')));
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
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'grapher-planner-paths-')));
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
    for (const { workspace, boundCwd, tools, hooks, context } of turns) {
      const expected = workspace === source ? 'source' : workspace === first ? 'first' : 'second';
      const bash = tools.get('bash'), read = tools.get('read');
      assert.equal(text(await bash.execute('pwd', { command: 'pwd -P' }, undefined, undefined, context)).trim(), '.');
      assert.equal(text(await read.execute('read-relative', { path: './value.txt' }, undefined, undefined, context)).trim(), expected);
      assert.equal(text(await read.execute('read-absolute', { path: join(source, 'value.txt') }, undefined, undefined, context)).trim(), expected);
      const write = tools.get('write'), edit = tools.get('edit');
      await write.execute('write-relative', { path: './plan.md', content: `plan ${expected}` }, undefined, undefined, context);
      assert.equal(await readFile(join(workspace, 'plan.md'), 'utf8'), `plan ${expected}`);
      await edit.execute('edit-absolute', { path: join(source, 'plan.md'), edits: [{ oldText: `plan ${expected}`, newText: `planned ${expected}` }] }, undefined, undefined, context);
      assert.equal(await readFile(join(workspace, 'plan.md'), 'utf8'), `planned ${expected}`);
      assert.equal(text(await bash.execute('bash-absolute', { command: `cat ${quote(shellPath(join(source, 'value.txt')))}` }, undefined, undefined, context)).trim(), expected);
      const updates: any[] = [];
      const result = await bash.execute('stream', { command: 'pwd -P' }, undefined, (update: any) => updates.push(update), context);
      assert.ok(updates.length);
      // No spelling of the physical cwd may leak, including the as-launched one.
      assert.ok(!JSON.stringify([result, updates]).includes(shellPath(workspace)));
      assert.ok(!JSON.stringify([result, updates]).includes(shellPath(boundCwd)));
      const encoded = `console.log(JSON.stringify({path:process.cwd(),uri:require('node:url').pathToFileURL(process.cwd()).href}))`;
      const output = JSON.parse(text(await bash.execute('encoded', { command: `${quote(shellPath(process.execPath))} -e ${quote(encoded)}` }, undefined, undefined, context)));
      assert.deepEqual(output, { path: '.', uri: pathToFileURL(source).href });
      const options = normalizeBuildSystemPromptOptions({ cwd: boundCwd, customPrompt: 'Planner system prompt.', appendSystemPrompt: 'Existing instructions.' });
      for (const hook of hooks.get('before_agent_start') ?? []) await hook({ systemPromptOptions: options });
      assert.equal(options.cwd, '.');
      assert.equal(options.customPrompt, 'Planner system prompt.');
      assert.equal(options.appendSystemPrompt, 'Existing instructions.');
      assert.equal(options.forceSystemPrompt, undefined);
      assert.ok(!buildSystemPrompt(options).includes(boundCwd), 'system prompt must not reveal the changing physical cwd');
      const user = { role: 'user', content: 'Continue the plan.' };
      const history = { role: 'toolResult', toolCallId: 'read-1', content: [{ type: 'text', text: join(boundCwd, 'value.txt') }] };
      const normalized = await hooks.get('context')![0]({ messages: [user, history] });
      assert.deepEqual(normalized.messages[0], user, 'no extra user instructions');
      assert.equal(normalized.messages[1].content[0].text.replaceAll('\\', '/'), './value.txt');
      await assert.rejects(() => read.execute('missing', { path: 'missing.txt' }, undefined, undefined, context),
        (error: Error) => !error.message.includes(workspace) && !error.message.includes(shellPath(workspace))
          && !error.message.includes(boundCwd) && !error.message.includes(shellPath(boundCwd)));
    }
    // Worktree turns edit through the model-visible source path; the source
    // copy must only ever reflect the source-native turns.
    assert.equal(await readFile(join(source, 'plan.md'), 'utf8'), 'planned source');
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
});

test('Planner Bash never exposes Grapher control paths to the model shell', { timeout: 30_000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'grapher-planner-env-')));
  // Keep the cache outside the workspace, as production does, so the path
  // adapter does not normalize the scratch to a workspace-relative spelling.
  const cache = await realpath(await mkdtemp(join(tmpdir(), 'grapher-planner-cache-')));
  const previousCache = process.env.GRAPHER_CACHE_DIR;
  const previousXdgCache = process.env.XDG_CACHE_HOME;
  const previousAskpass = process.env.GIT_ASKPASS;
  const previousAskpassNode = process.env.VSCODE_GIT_ASKPASS_NODE;
  try {
    process.env.GRAPHER_CACHE_DIR = cache;
    // Control the scratch base: modelShellScratch prefers XDG_CACHE_HOME.
    delete process.env.XDG_CACHE_HOME;
    // The host Git credential helper must survive so private-remote auth works.
    process.env.GIT_ASKPASS = 'C:\\ide\\git\\askpass.sh';
    process.env.VSCODE_GIT_ASKPASS_NODE = 'C:\\ide\\node.exe';
    const { tools, context } = await plannerTools(directory, directory, false);
    const output = text(await tools.get('bash').execute('bash', { command: 'env' }, undefined, undefined, context));
    assert.ok(!/^GRAPHER_/m.test(output), `model shell leaked Grapher control variables:\n${output}`);
    assert.ok(!/[\\/]data[\\/]sessions/i.test(output), `model shell leaked the Run data path:\n${output}`);
    assert.ok(!/^(?:PI_SESSION_FILE|PI_CODING_AGENT_DIR|ANTIGRAVITY_CLI_ALIAS|TERM_PROGRAM)/m.test(output),
      `model shell leaked a Pi/editor path:\n${output}`);
    assert.ok(output.includes('GIT_ASKPASS=C:\\ide\\git\\askpass.sh'), `the credential helper must stay:\n${output}`);
    assert.ok(output.includes('VSCODE_GIT_ASKPASS_NODE=C:\\ide\\node.exe'), output);
    const tmpLine = output.split('\n').find(line => line.startsWith('TMPDIR='));
    assert.ok(tmpLine, output);
    // The model-visible spelling may be host or Git Bash form; the invariant is
    // that the scratch is the cache tmp and never the session/data directory.
    const scratch = tmpLine!.slice('TMPDIR='.length);
    assert.ok(scratch.endsWith('/tmp') || scratch.endsWith('\\tmp'), output);
    assert.ok(scratch.includes(cache.split(/[\\/]/).pop()!), output);
    assert.ok(!/[\\/]data[\\/]/i.test(scratch), output);
  } finally {
    if (previousCache === undefined) delete process.env.GRAPHER_CACHE_DIR;
    else process.env.GRAPHER_CACHE_DIR = previousCache;
    if (previousXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousXdgCache;
    if (previousAskpass === undefined) delete process.env.GIT_ASKPASS;
    else process.env.GIT_ASKPASS = previousAskpass;
    if (previousAskpassNode === undefined) delete process.env.VSCODE_GIT_ASKPASS_NODE;
    else process.env.VSCODE_GIT_ASKPASS_NODE = previousAskpassNode;
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    await rm(cache, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
});

test('the model shell never receives Grapher data/state or install paths', () => {
  const env: Record<string, string> = {
    HOME: 'C:/run/workspaces/.grapher-worktrees/run/.grapher-state/abc/process/.agent-home',
    XDG_CACHE_HOME: 'C:/run/workspaces/.grapher-worktrees/run/.grapher-state/abc/process/.runtime-cache/xdg',
    TMPDIR: '/tmp/run/data/sessions/abc',
    TMP: '/tmp/run/data/sessions/abc',
    TEMP: 'C:\\run\\data\\sessions\\abc',
    XDG_RUNTIME_DIR: 'C:\\run\\data\\sessions\\abc',
    GRAPHER_LAUNCH_BINDING: 'C:\\run\\data\\sessions\\abc\\launch.json',
    GRAPHER_ENVIRONMENT_DISCOVERY: 'C:\\run\\data\\sessions\\abc\\observer.json',
    GRAPHER_ENVIRONMENT_HELPER: 'C:\\install\\grapher.exe',
    GRAPHER_COMPILER_PATH: 'C:\\install\\grapher.exe',
    GRAPHER_ENVIRONMENT_DATA: '\\\\?\\C:\\run\\data',
    PI_SESSION_FILE: 'C:\\run\\data\\sessions\\abc\\session.jsonl',
    PI_CODING_AGENT_DIR: 'C:\\Users\\user\\.grapher\\pi-agent',
    PI_SESSION_ID: 'abc-session',
    PI_MODEL: 'example/model',
    GIT_ASKPASS: 'C:\\ide\\git\\askpass.sh',
    VSCODE_GIT_ASKPASS_NODE: 'C:\\ide\\node.exe',
    ANTIGRAVITY_CLI_ALIAS: 'agy-ide',
  };
  const scratch = scrubModelShellEnvironment(env);
  assert.equal(Object.keys(env).some(key => /^GRAPHER_/i.test(key)), false, 'Grapher control keys must not reach the model shell');
  assert.equal(scratch, 'C:/run/workspaces/.grapher-worktrees/run/.grapher-state/abc/process/.runtime-cache/xdg/tmp');
  for (const key of ['TMPDIR', 'TMP', 'TEMP', 'XDG_RUNTIME_DIR']) assert.equal(env[key], scratch, key);
  for (const key of ['PI_SESSION_FILE', 'PI_CODING_AGENT_DIR', 'PI_SESSION_ID', 'ANTIGRAVITY_CLI_ALIAS']) {
    assert.equal(key in env, false, `${key} must not reach the model shell`);
  }
  assert.equal(env.GIT_ASKPASS, 'C:\\ide\\git\\askpass.sh', 'the host credential helper must stay usable');
  assert.equal(env.VSCODE_GIT_ASKPASS_NODE, 'C:\\ide\\node.exe', 'the askpass script needs its node binding');
  assert.equal(env.PI_MODEL, 'example/model', 'PI_* metadata without a path is kept');
  assert.equal(env.HOME, 'C:/run/workspaces/.grapher-worktrees/run/.grapher-state/abc/process/.agent-home');
});

test('a shell with no Grapher cache base drops the session temp binding instead of leaking data/', () => {
  const env: Record<string, string> = {
    HOME: '/c/Users/user',
    TMPDIR: '/tmp/run/data/sessions/abc',
    GRAPHER_MODE: 'planner',
    PI_SESSION_FILE: '/tmp/run/data/sessions/abc/session.jsonl',
  };
  assert.equal(scrubModelShellEnvironment(env), undefined);
  assert.equal('TMPDIR' in env, false);
  assert.equal('GRAPHER_MODE' in env, false);
  assert.equal('PI_SESSION_FILE' in env, false);
});
