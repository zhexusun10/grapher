import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
import { createWorkspacePaths, registerWorkspacePaths } from '../backend/resources/workspace-paths.mjs';

function workspace(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return createWorkspacePaths(root);
}

test('concurrent agents resolve identical visible paths to their own files', async t => {
  const a = workspace(t, 'agent a-'), b = workspace(t, 'agent b-');
  await Promise.all([a, b].map(async (paths, i) => {
    fs.writeFileSync(paths.physical('/workspace/value.txt'), String(i) + '\n');
    const { stdout: result } = await exec('/bin/bash', ['-c', paths.command('cat /workspace/value.txt; pwd')], { cwd: paths.root, encoding: 'utf8' });
    assert.equal(paths.visible(result), `${i}\n/workspace\n`);
    assert.equal(paths.visible(paths.root + '-other'), paths.root + '-other');
    assert.equal(paths.physical('/workspace-other/file'), '/workspace-other/file');
  }));
});

test('shell translation handles quoted paths and writes inside the mapped checkout', t => {
  const paths = workspace(t, "agent 'quote $d-");
  for (const expression of ['/workspace/file', '"/workspace/file"', "'/workspace/file'"]) {
    execFileSync('/bin/bash', ['-c', paths.command(`printf contents > ${expression}`)], { cwd: paths.root });
    assert.equal(fs.readFileSync(path.join(paths.root, 'file'), 'utf8'), 'contents');
  }
});

test('mapped commands retain shell conditionals, variables, child processes and failures', async t => {
  const paths = workspace(t, 'agent commands-');
  fs.writeFileSync(paths.physical('/workspace/marker'), 'local');
  const commands = [
    'cd /workspace&&pwd',
    'dir=/workspace; cat "$dir/marker"',
    'cat /workspace/missing 2>/dev/null||cat /workspace/marker',
    `node -e 'console.log(require("node:fs").readFileSync("/workspace/marker", "utf8"))'`,
    `sh -c 'cat /workspace/marker'`,
  ];
  for (const command of commands) {
    const { stdout } = await exec('/bin/bash', ['-c', paths.command(command)], { cwd: paths.root });
    assert.match(paths.visible(stdout), /local|\/workspace/);
  }
  await assert.rejects(exec('/bin/bash', ['-c', paths.command('cat /workspace/missing')], { cwd: paths.root }), error => {
    assert.match(paths.visible(error.stderr), /\/workspace\/missing/);
    assert.ok(!paths.visible(error.stderr).includes(paths.root));
    return true;
  });
});

test('mapping composes with Seatbelt access checks on real paths', { skip: process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec') }, async t => {
  const paths = workspace(t, 'agent sandbox-'), sibling = workspace(t, 'agent sibling-');
  fs.writeFileSync(paths.physical('/workspace/marker'), 'allowed');
  fs.writeFileSync(path.join(sibling.root, 'marker'), 'protected');
  const profile = `(version 1)(allow default)(deny file-read* file-write* (subpath ${JSON.stringify(sibling.root)}))`;
  const { stdout } = await exec('/usr/bin/sandbox-exec', ['-p', profile, '/bin/bash', '-c', paths.command('cat /workspace/marker; printf updated > /workspace/output')], { cwd: paths.root });
  assert.equal(stdout, 'allowed');
  assert.equal(fs.readFileSync(paths.physical('/workspace/output'), 'utf8'), 'updated');
  const relativeEscape = '/workspace/' + path.relative(paths.root, path.join(sibling.root, 'marker'));
  assert.throws(() => paths.command(`cat "${relativeEscape}"`), /escapes \/workspace/);
  assert.throws(() => paths.physical(relativeEscape), /escapes \/workspace/);
  assert.equal(fs.readFileSync(path.join(sibling.root, 'marker'), 'utf8'), 'protected');
});

test('model context and tool interfaces share the virtual namespace', async t => {
  const paths = workspace(t, 'agent-hooks-');
  const handlers = new Map();
  registerWorkspacePaths({ on: (event, handler) => handlers.set(event, handler) }, paths.root);
  assert.equal((await handlers.get('before_agent_start')({ systemPrompt: `cwd: ${paths.root}` })).systemPrompt, 'cwd: /workspace');
  const event = { toolName: 'read', input: { path: '/workspace/src/a.js' } };
  await handlers.get('tool_call')(event);
  assert.equal(event.input.path, path.join(paths.root, 'src/a.js'));
  const escaped = { toolName: 'read', input: { path: '/workspace/../outside' } };
  assert.deepEqual(await handlers.get('tool_call')(escaped), { block: true, reason: 'Workspace path escapes /workspace' });
  assert.equal(escaped.input.path, '/workspace/../outside');
  const edit = { toolName: 'edit', input: { path: '/workspace/a', oldText: '/workspace/literal', newText: '/workspace/other' } };
  await handlers.get('tool_call')(edit);
  assert.equal(edit.input.newText, '/workspace/other');
  const context = await handlers.get('context')({ messages: [{ role: 'toolResult', content: [{ type: 'text', text: `${paths.root}/error.js:1` }] }] });
  assert.equal(context.messages[0].content[0].text, '/workspace/error.js:1');
  const result = await handlers.get('tool_result')({ content: [{ type: 'text', text: paths.root }], details: { path: paths.root } });
  assert.equal(result.content[0].text, '/workspace');
  assert.equal(paths.physical('/workspace.'), '/workspace.');
  assert.equal(paths.physical('prefix /workspace/file'), 'prefix /workspace/file');
  const opaque = { role: 'assistant', id: paths.root, content: [
    { type: 'thinking', thinking: paths.root, signature: paths.root },
    { type: 'text', text: `At ${paths.root}.`, textSignature: paths.root },
    { type: 'image', data: paths.root },
  ] };
  const mapped = paths.view(opaque);
  assert.equal(mapped.content[0].thinking, paths.root);
  assert.equal(mapped.content[0].signature, paths.root);
  assert.equal(mapped.content[1].text, 'At /workspace.');
  assert.equal(mapped.content[1].textSignature, paths.root);
  assert.equal(mapped.content[2].data, paths.root);
  assert.equal(mapped.id, paths.root);
  assert.equal(opaque.content[1].text, `At ${paths.root}.`);
  assert.equal(result.details.path, '/workspace');
});
