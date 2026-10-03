// The exact same Planner tool contract runs on macOS, Windows and Linux.
// No backend/model/provider is involved: this is pinned Pi's real native Bash.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createBashToolDefinition } from '../pi/packages/coding-agent/src/core/tools/bash.ts';
import { loadExtensions } from '../pi/packages/coding-agent/src/core/extensions/loader.ts';
import { getShellConfig } from '../pi/packages/coding-agent/src/utils/shell.ts';

const root = resolve('.');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const shellPath = (value: string) => process.platform === 'win32' ? value.replaceAll('\\', '/') : value;

test('Planner uses unmodified native Bash and writes directly to its source on every platform', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'grapher-planner-bash-'));
  const source = join(directory, '中文 space # %');
  const previous = process.cwd();
  try {
    await mkdir(source);
    process.chdir(source);
    const loaded = await loadExtensions([join(root, 'backend/resources/planner.ts')], source);
    process.chdir(previous);
    assert.deepEqual(loaded.errors, []);
    const planner = loaded.extensions[0].tools.get('bash')!.definition;
    const builtin = createBashToolDefinition(source);
    assert.equal(planner.execute.toString(), builtin.execute.toString());
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
    const context = { cwd: source, sessionManager: { getSessionId: () => 'bash-test', getSessionFile: () => undefined } } as any;
    for (const tool of [builtin, planner]) {
      for (const [command, expected] of cases) {
        const input = { command };
        const response = await tool.execute('bash-test', input, undefined, undefined, context);
        const output = response.content.filter(part => part.type === 'text').map(part => part.text).join('\n').trim();
        if (typeof expected === 'string') assert.equal(output, expected);
        else assert.match(output, expected);
        assert.equal(input.command, command, 'the input command must not be rewritten');
      }
      assert.equal(await readFile(join(source, 'absolute.txt'), 'utf8'), 'absolute');
      assert.equal(await readFile(join(source, 'nested/file.txt'), 'utf8'), 'firstsecond');
      const nonzero = await tool.execute('nonzero', { command: 'exit 7' }, undefined, undefined, context);
      assert.equal(nonzero.isError, true);
      assert.match(nonzero.content.find(part => part.type === 'text')?.text || '', /exited with code 7/);
      await assert.rejects(() => tool.execute('timeout', { command: 'sleep 2', timeout: 0.1 }, undefined, undefined, context), /timed out/i);
    }
  } finally {
    process.chdir(previous);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
});
