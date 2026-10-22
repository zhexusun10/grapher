import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export default async function (pi: any) {
  const extension = await import(pathToFileURL(join(process.env.GRAPHER_TEST_RUNTIME!, 'engine/prompt-extension.ts')).href);
  const tools: any[] = [];
  extension.default({ ...pi, registerTool(tool: any) { tools.push(tool); } });
  const call = async (name: string, input: any) => {
    const tool = tools.find(tool => tool.name === name);
    assert.ok(tool, `Missing ${name}`);
    return tool.execute(crypto.randomUUID(), input);
  };
  const text = (result: any) => result.content?.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n') || '';
  const target = JSON.parse(process.env.GRAPHER_PLANNER_WORKSPACES!).target;
  await call('switch_workspace', { node: 'target' });
  assert.equal(process.cwd(), realpathSync.native(target.workspace));
  assert.equal(readFileSync('business.txt', 'utf8'), 'target');
  assert.equal(process.env.HOME, target.runtimeEnvironment.HOME);
  assert.match(text(await call('read', { path: 'business.txt' })), /target/);
  assert.equal(text(await call('bash', { command: 'cat business.txt' })).trim(), 'target');
  assert.equal(text(await call('bash', { command: 'git config --global --get user.name' })).trim(), 'target-state');
  writeFileSync(join(process.env.HOME!, 'planner-written'), 'target-owned');
  await call('write', { path: 'task.txt', content: 'selected target' });
  if (process.platform !== 'win32') {
    assert.throws(() => readFileSync(join(process.env.GRAPHER_TEST_DENIED!, 'business.txt')));
  }
  process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'planner-switch-ok' }] } }) + '\n');
  process.exit(0);
}
