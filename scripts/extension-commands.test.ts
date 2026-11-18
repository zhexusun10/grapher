import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExtensionCommands } from '../engine/extension-commands.ts';

async function fixture(run: (host: ExtensionCommands, paths: { base: string; own: string; global: string; a: string; b: string }) => Promise<void>) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'grapher-extension-commands-')));
  const paths = { base, own: join(base, 'own'), global: join(base, 'global'), a: join(base, 'project-a'), b: join(base, 'project-b') };
  for (const directory of [paths.own, paths.global, paths.a, paths.b]) mkdirSync(directory);
  mkdirSync(join(paths.global, 'extensions'));
  writeFileSync(join(paths.global, 'extensions/custom.ts'), `export default function(pi) {
    pi.registerCommand('custom-settings', { description: 'User-defined settings', handler: async (_args, ctx) => {
      const choice = await ctx.ui.select('Choose action', ['Inspect', 'Cancel']);
      if (choice !== 'Inspect') return;
      const value = await ctx.ui.input('Enter value');
      if (value !== undefined) ctx.ui.notify('Saved: ' + value + ' in ' + ctx.cwd, 'info');
    }});
    pi.registerCommand('requires-history', { handler: async (_args, ctx) => {
      ctx.compact({ onError: () => ctx.ui.notify('An active conversation is required', 'warning') });
    }});
  }`);
  writeFileSync(join(paths.own, 'extensions.json'), JSON.stringify({ overrides: { 'npm:pi-better-web-search': true } }));
  for (const [directory, name] of [[paths.a, 'project-a-command'], [paths.b, 'project-b-command']]) {
    mkdirSync(join(directory, '.pi/extensions'), { recursive: true });
    writeFileSync(join(directory, '.pi/extensions/project.ts'), `export default function(pi) {
      pi.registerCommand('${name}', { handler: async (_args, ctx) => ctx.ui.notify(ctx.cwd, 'info') });
    }`);
  }
  writeFileSync(join(paths.global, 'mcp.json'), JSON.stringify({ mcpServers: { global: { command: 'must-not-start', enabled: false } } }));
  writeFileSync(join(paths.a, '.pi/mcp.json'), JSON.stringify({ mcpServers: { projectA: { command: 'must-not-start', enabled: false } } }));
  writeFileSync(join(paths.b, '.pi/mcp.json'), JSON.stringify({ mcpServers: { projectB: { command: 'must-not-start', enabled: false } } }));
  const env = { PI_CODING_AGENT_DIR: paths.own, GRAPHER_GLOBAL_PI_AGENT_DIR: paths.global,
    GRAPHER_ISOLATED_PI_MODELS: '1', GRAPHER_ISOLATED_PI_SEARCH: '1', PI_OFFLINE: '1' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const host = new ExtensionCommands();
  try { await run(host, paths); }
  finally {
    await host.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(base, { recursive: true, force: true });
  }
}
async function start(host: ExtensionCommands, repository: string, text: string) {
  const fields = { repository, instance: host.instance, commandId: randomUUID() };
  await host.dispatch({ ...fields, operation: 'execute', text });
  return fields;
}
async function poll(host: ExtensionCommands, fields: object, ready: (state: any) => boolean) {
  const events: any[] = [];
  for (let attempt = 0; attempt < 500; attempt++) {
    const state: any = await host.dispatch({ ...fields, operation: 'poll' });
    events.push(...state.events);
    const result = { ...state, events };
    if (ready(result)) return result;
    if (state.status !== 'pending') assert.fail(JSON.stringify(result));
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Extension command did not reach the expected state');
}
const dialog = (state: any, method: string) => state.events.findLast((event: any) => event.method === method);
const respond = (host: ExtensionCommands, fields: object, prompt: any, response: object) =>
  host.dispatch({ ...fields, operation: 'respond', response: { id: prompt.id, ...response } });

test('standalone command discovery loads user extensions, bundled commands and MCP without a conversation', { timeout: 30_000 }, () => fixture(async (host, paths) => {
  const catalog: any = await host.dispatch({ repository: paths.a, operation: 'catalog' });
  const names = catalog.commands.map((command: any) => command.name);
  for (const name of ['custom-settings', 'pi-better-web-search', 'web-search-provider', 'web-search-api', 'mcp', 'project-a-command']) assert.ok(names.includes(name), name);
  const withoutProject: any = await host.dispatch({ operation: 'catalog' });
  assert.ok(withoutProject.commands.some((command: any) => command.name === 'custom-settings'));
  assert.ok(!withoutProject.commands.some((command: any) => command.name === 'project-a-command'));
  const help = await start(host, '', '/pi-better-web-search help');
  const helpResult = await poll(host, help, state => state.status === 'complete');
  assert.ok(helpResult.events.some((event: any) => /web-search-provider/.test(event.message ?? '')));
  const fields = await start(host, paths.a, '/custom-settings');
  const choice = dialog(await poll(host, fields, state => !!dialog(state, 'select')), 'select');
  await respond(host, fields, choice, { value: 'Inspect' });
  const input = dialog(await poll(host, fields, state => !!dialog(state, 'input')), 'input');
  await respond(host, fields, input, { value: 'custom-value' });
  const completed = await poll(host, fields, state => state.status === 'complete');
  assert.ok(completed.events.some((event: any) => event.message === `Saved: custom-value in ${paths.a}`));
  for (const directory of [paths.own, paths.a]) assert.equal(existsSync(join(directory, 'sessions')), false);
}));

test('project extension and MCP discovery follows the selected project and preserves configuration bytes', { timeout: 30_000 }, () => fixture(async (host, paths) => {
  const before = readFileSync(join(paths.a, '.pi/mcp.json'), 'utf8');
  for (const [repository, own, other] of [[paths.a, 'a', 'b'], [paths.b, 'b', 'a']]) {
    const catalog: any = await host.dispatch({ repository, operation: 'catalog' });
    assert.ok(catalog.commands.some((command: any) => command.name === `project-${own}-command`));
    assert.ok(!catalog.commands.some((command: any) => command.name === `project-${other}-command`));
    const fields = await start(host, repository, '/mcp');
    const state = await poll(host, fields, state => state.status === 'complete');
    const status = state.events.map((event: any) => event.message).join('\n');
    assert.match(status, /global: disabled/);
    assert.ok(status.includes(`project${own.toUpperCase()}: disabled`));
    assert.ok(!status.includes(`project${other.toUpperCase()}:`));
  }
  assert.equal(readFileSync(join(paths.a, '.pi/mcp.json'), 'utf8'), before);
}));

test('standalone command replies reject stale host, project and dialog identities and cancel pending input', { timeout: 30_000 }, () => fixture(async (host, paths) => {
  const fields = await start(host, paths.a, '/custom-settings');
  const choice = dialog(await poll(host, fields, state => !!dialog(state, 'select')), 'select');
  await assert.rejects(respond(host, fields, choice, { value: 'invalid' }), /Invalid selection/);
  await assert.rejects(respond(host, { ...fields, repository: paths.b }, choice, { value: 'Inspect' }), /project changed/);
  await assert.rejects(respond(host, { ...fields, instance: randomUUID() }, choice, { value: 'Inspect' }), /host changed/);
  await respond(host, fields, choice, { value: 'Inspect' });
  const input = dialog(await poll(host, fields, state => !!dialog(state, 'input')), 'input');
  await assert.rejects(respond(host, fields, choice, { value: 'Inspect' }), /no longer active/);
  await host.dispatch({ ...fields, operation: 'cancel' });
  await assert.rejects(respond(host, fields, input, { value: 'late-value' }), /no longer active/);
  assert.equal((await host.dispatch({ ...fields, operation: 'poll' }) as any).status, 'cancelled');
}));

test('unknown commands and commands requiring history never become model prompts', { timeout: 30_000 }, () => fixture(async (host, paths) => {
  const unknown = await start(host, paths.a, '/not-registered');
  const failed = await poll(host, unknown, state => state.status === 'failed');
  assert.match(failed.error, /active session|unavailable/);
  const history = await start(host, paths.a, '/requires-history');
  const result = await poll(host, history, state => state.status === 'complete');
  assert.ok(result.events.some((event: any) => /active conversation|extension operation failed/.test(event.message ?? '')));
  assert.equal(existsSync(join(paths.own, 'sessions')), false);
}));
