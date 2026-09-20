// Loaded as an ordinary explicit Pi extension by the production native launcher
// in tests. No provider/model call. Tool implementations and adapter are the
// actual staged production modules, not a replacement execution backend.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export default async function () {
  try {
    const runtime = process.env.GRAPHER_TEST_RUNTIME!;
    const source = process.env.GRAPHER_ORIGINAL_ROOT!;
    const cwd = process.cwd();
    const label = process.env.GRAPHER_TEST_LABEL!;
    const tools = new Map<string, any>();
    const hooks = new Map<string, any[]>();
    const extension = await import(pathToFileURL(join(runtime, 'engine/prompt-extension.ts')).href);
    extension.default({
      registerTool(tool: any) { tools.set(tool.name, tool); },
      on(event: string, callback: any) { hooks.set(event, [...(hooks.get(event) || []), callback]); },
    });
    async function call(name: string, params: any, signal?: AbortSignal) {
      const tool = tools.get(name);
      assert.ok(tool, `${name} registered by production adapter`);
      return tool.execute(`${label}-${name}`, params, signal);
    }
    const text = (value: any) => value.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n');
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    const visible = join(source, 'mapped.txt');
    const sessionIndex = process.argv.indexOf('--session-dir');
    assert.ok(sessionIndex >= 0);
    writeFileSync(join(process.argv[sessionIndex + 1], 'probe-session-write'), label);
    await call('write', { path: visible, content: `first-${label}` });
    await call('edit', { path: visible, edits: [{ oldText: `first-${label}`, newText: `final-${label}` }] });
    assert.equal(text(await call('read', { path: visible })), `final-${label}`);
    assert.equal(text(await call('read', { path: 'mapped.txt' })), `final-${label}`);
    await call('write', { path: join(source, 'literal.txt'), content: `keep ${source} unchanged` });
    assert.equal(readFileSync(join(cwd, 'literal.txt'), 'utf8'), `keep ${source} unchanged`);
    assert.match(text(await call('ls', { path: source })), /mapped.txt/);
    assert.match(text(await call('find', { path: source, pattern: 'mapped.txt' })), /mapped.txt/);
    assert.match(text(await call('grep', { path: source, pattern: `final-${label}` })), /mapped.txt/);
    // External absolute script and absolute script within the real workspace.
    const external = process.env.GRAPHER_TEST_EXTERNAL!;
    await call('write', { path: join(source, 'local.cjs'), content: "require('node:fs').writeFileSync('local-ran', 'ok')" });
    await call('bash', { command: `${quote(process.execPath)} ${quote(external)} ${quote(label)}` });
    await call('bash', { command: `${quote(process.execPath)} ${quote(join(cwd, 'local.cjs'))}` });
    assert.equal(readFileSync(join(cwd, 'external-ran'), 'utf8'), label);
    assert.equal(readFileSync(join(cwd, 'local-ran'), 'utf8'), 'ok');
    assert.equal(text(await call('read', { path: join(source, 'external-link') })), 'external material');
    // Bash remains native. Source absolute writes, siblings, aliases and other
    // sessions fail under the inherited kernel policy, even in nested children.
    const denied = [join(source, 'source-marker'), join(cwd, 'source-link', 'source-marker'),
      process.env.GRAPHER_TEST_SIBLING!, process.env.GRAPHER_TEST_OTHER_SESSION!];
    for (const path of denied) {
      const code = `require('node:fs').writeFileSync(Buffer.from(${JSON.stringify(Buffer.from(path).toString('base64'))}, 'base64').toString(), 'BAD')`;
      await assert.rejects(call('bash', { command: `${quote(process.execPath)} -e ${quote(code)}` }), /exited with code/);
    }
    assert.throws(() => writeFileSync(join(runtime, 'engine/entrypoint.mjs'), 'BAD'), /permitted|denied/i);
    const shell = await call('bash', { command: 'false | true; false; printf native-ok' });
    assert.equal(shell.details.exitCode, 0);
    assert.equal(text(shell).trim(), 'native-ok');
    await assert.rejects(call('bash', { command: 'sleep 2', timeout: 0.1 }), /timed out/i);
    const controller = new AbortController();
    const cancel = call('bash', { command: 'sleep 2' }, controller.signal);
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(cancel, /abort/i);
    // Nested Node constructs relative paths: inherits actual cwd and policy.
    const nested = `require('node:child_process').execFileSync(process.execPath,['-e',"require('node:fs').writeFileSync('nested-ran','ok')"])`;
    await call('bash', { command: `${quote(process.execPath)} -e ${quote(nested)}` });
    assert.equal(readFileSync(join(cwd, 'nested-ran'), 'utf8'), 'ok');
    const system = await hooks.get('before_agent_start')![0]({ systemPrompt: 'base' });
    assert.equal(system.systemPrompt, 'base', 'No instructions are appended or modified');
    const systemWithCwd = await hooks.get('before_agent_start')![0]({ systemPrompt: `Original instructions.\nCurrent working directory: ${cwd}` });
    assert.equal(systemWithCwd.systemPrompt, `Original instructions.\nCurrent working directory: ${source}`);
    const updates: any[] = [];
    const bash = tools.get('bash');
    for (const command of [
      `cat ${quote(visible)}`,
      `p=${quote(source)}; cat "$p/mapped.txt"`,
      `sh -c ${quote(`cat ${quote(visible)}`)}`,
    ]) {
      const input = { command };
      assert.equal(text(await bash.execute('mapped-bash', input, undefined, (v: any) => updates.push(v))).trim(), `final-${label}`);
      assert.equal(input.command, command);
    }
    const pwd = await bash.execute('pwd', { command: 'pwd -P' }, undefined, (v: any) => updates.push(v));
    assert.equal(text(pwd).trim(), source);
    for (const command of [
      `cat < ${quote(visible)}`,
      `env PROJECT=${quote(source)} sh -c 'cat "$PROJECT/mapped.txt"'`,
      `cat "$(printf %s ${quote(source)})/mapped.txt"`,
    ]) assert.equal(text(await bash.execute('more-patterns', { command })).trim(), `final-${label}`);
    const encodedOutput = `console.log(JSON.stringify({path:process.cwd(),uri:require('node:url').pathToFileURL(process.cwd()).href,encoded:encodeURIComponent(process.cwd())}))`;
    const encoded = text(await bash.execute('encoded', { command: `${quote(process.execPath)} -e ${quote(encodedOutput)}` }));
    const parsed = JSON.parse(encoded);
    assert.equal(parsed.path, source);
    assert.equal(parsed.uri, pathToFileURL(source).href);
    assert.equal(parsed.encoded, encodeURIComponent(source));
    const errorResult = await bash.execute('mapped-error', { command: 'cat missing-in-workspace' }).catch((error: Error) => error.message);
    assert.ok(!JSON.stringify(errorResult).includes(cwd));
    const explicit = await bash.execute('physical-input', { command: `cat ${quote(join(cwd, 'mapped.txt'))}` });
    assert.ok(!JSON.stringify(explicit).includes(cwd), 'metadata must not leak raw physical command');
    assert.ok(!JSON.stringify(updates).includes(cwd));
    const context = await hooks.get('context')![0]({ messages: [{ role: 'user', content: `Read ${cwd}/mapped.txt` }] });
    assert.ok(!JSON.stringify(context).includes(cwd));
    const opaque = { type: 'thinking', thinking: cwd, signature: cwd };
    const preserved = await hooks.get('context')![0]({ messages: [opaque] });
    assert.deepEqual(preserved.messages[0], opaque);
    writeFileSync(join(cwd, 'launcher-tools-passed'), label);
    process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: `native-tools-passed-${label}` }] } }) + '\n');
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
