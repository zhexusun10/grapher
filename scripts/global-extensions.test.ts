import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundledTrim, extensionCatalog, executionResources, setExtensionEnabled, trimId } from '../engine/global-extensions.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'grapher-global-extensions-'));
  const global = join(base, 'global');
  const own = join(base, 'own');
  const workspace = join(base, 'workspace');
  for (const path of [global, own, workspace, join(global, 'extensions'), join(global, 'skills/probe')]) mkdirSync(path, { recursive: true });
  const extension = join(global, 'extensions/probe.ts');
  writeFileSync(extension, 'throw new Error("Discovery must not execute extensions");');
  writeFileSync(join(global, 'skills/probe/SKILL.md'), '---\nname: global-skill\ndescription: global skill probe\n---\nUse the probe.\n');
  const previous = process.env.GRAPHER_GLOBAL_PI_AGENT_DIR;
  process.env.GRAPHER_GLOBAL_PI_AGENT_DIR = global;
  return { base, global, own, workspace, extension, close() {
    if (previous === undefined) delete process.env.GRAPHER_GLOBAL_PI_AGENT_DIR;
    else process.env.GRAPHER_GLOBAL_PI_AGENT_DIR = previous;
    rmSync(base, { recursive: true, force: true });
  } };
}

test('global auto-discovery, deletion and restore persist without editing global settings/files', async () => {
  const f = fixture();
  try {
    const settings = JSON.stringify({ extensions: ['-extensions/probe.ts'], packages: ['npm:missing-grapher-extension-probe'] });
    writeFileSync(join(f.global, 'settings.json'), settings);
    let catalog = await extensionCatalog(f.own);
    assert.equal(catalog.globalDirectory, f.global);
    const probe = catalog.extensions.find(extension => !extension.bundled)!;
    assert.ok(probe);
    assert.equal(probe.enabled, false, 'upstream exclusions start in the available list');
    assert.equal(catalog.extensions.filter(extension => extension.id === trimId).length, 1);
    catalog = await setExtensionEnabled(f.own, probe.id, true);
    assert.equal(catalog.extensions.find(extension => extension.id === probe.id)?.enabled, true);
    const enabled = await executionResources([], f.own, 'planner');
    assert.ok(enabled.args.includes(f.extension));
    assert.ok(enabled.args.includes(join(f.global, 'skills/probe/SKILL.md')) || enabled.args.includes(join(f.global, 'skills/probe')));
    await setExtensionEnabled(f.own, probe.id, false);
    assert.equal((await extensionCatalog(f.own)).extensions.find(extension => extension.id === probe.id)?.enabled, false);
    assert.ok(!(await executionResources([], f.own, 'node')).args.includes(f.extension));
    await setExtensionEnabled(f.own, probe.id, true);
    assert.ok((await executionResources([], f.own, 'node')).args.includes(f.extension));
    assert.equal(readFileSync(join(f.global, 'settings.json'), 'utf8'), settings);
    assert.ok(existsSync(f.extension));
    await assert.rejects(setExtensionEnabled(f.own, 'not-a-discovered-extension', true), /Unknown Pi extension/);
  } finally { f.close(); }
});

test('only pi-trim and the host adapter reach Partitioner/Merger; trim is mandatory for all roles', async () => {
  const f = fixture();
  try {
    // Even malformed/unreadable user config must not affect restricted roles.
    writeFileSync(join(f.global, 'settings.json'), 'invalid json');
    for (const role of ['partition', 'merger']) {
      const resources = await executionResources([], f.own, role);
      assert.ok(resources.args.includes(bundledTrim));
      assert.ok(resources.args.includes('--no-extensions'));
      assert.ok(resources.args.includes('--no-skills'));
      assert.ok(!resources.args.includes('--skill'));
      assert.equal(resources.extensionFactories.length, 0, 'no MCP factory');
      assert.equal(resources.args.filter(arg => arg === '--extension').length, 2);
    }
    writeFileSync(join(f.global, 'settings.json'), '{}');
    const legacy = JSON.stringify({ overrides: { [trimId]: false } });
    writeFileSync(join(f.own, 'extensions.json'), legacy);
    assert.equal((await extensionCatalog(f.own)).extensions.find(extension => extension.id === trimId)?.enabled, true);
    for (const enabled of [false, true]) {
      await assert.rejects(setExtensionEnabled(f.own, trimId, enabled), /pi-trim is required/);
    }
    assert.equal(readFileSync(join(f.own, 'extensions.json'), 'utf8'), legacy, 'rejected changes do not write settings');
    for (const role of ['partition', 'merger', 'planner', 'node']) {
      assert.equal((await executionResources([], f.own, role)).args.filter(arg => arg === bundledTrim).length, 1);
    }
  } finally { f.close(); }
});

test('MCP is available only to allowed roles and respects global/dedicated builtin exclusions', async () => {
  const f = fixture();
  try {
    for (const role of ['planner', 'node']) {
      const resources = await executionResources([], f.own, role);
      assert.ok(resources.extensionFactories.some(factory => typeof factory === 'object' && factory.name === 'grapher-mcp'));
    }
    writeFileSync(join(f.global, 'settings.json'), JSON.stringify({ extensions: ['-builtin:mcp'] }));
    for (const role of ['planner', 'node', 'partition', 'merger']) {
      assert.equal((await executionResources([], f.own, role)).extensionFactories.length, 0);
    }
    writeFileSync(join(f.global, 'settings.json'), '{}');
    writeFileSync(join(f.own, 'settings.json'), JSON.stringify({ extensions: ['-builtin:mcp'] }));
    assert.equal((await executionResources([], f.own, 'node')).extensionFactories.length, 0);
    const withoutExtensions = await executionResources(['--no-extensions'], f.own, 'node');
    assert.ok(!withoutExtensions.args.includes(f.extension));
    assert.ok(withoutExtensions.args.includes('--skill'), 'disabling extensions alone does not disable skills');
    assert.equal(withoutExtensions.extensionFactories.length, 0);
  } finally { f.close(); }
});

test('selection also works when dedicated and global Pi directories are identical', async () => {
  const f = fixture();
  try {
    const probe = (await extensionCatalog(f.global)).extensions.find(extension => !extension.bundled)!;
    assert.equal((await executionResources([], f.global, 'node')).args.filter(path => path === f.extension).length, 1);
    await setExtensionEnabled(f.global, probe.id, false);
    assert.ok(!(await executionResources([], f.global, 'node')).args.includes(f.extension));
    await setExtensionEnabled(f.global, probe.id, true);
    assert.equal((await executionResources([], f.global, 'node')).args.filter(path => path === f.extension).length, 1);
  } finally { f.close(); }
});

test('globally installed pi-trim is deduplicated with the bundled package, including multi-entry packages', async () => {
  const f = fixture();
  try {
    const pkg = join(f.global, 'trim-package');
    mkdirSync(pkg);
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'pi-trim', pi: { extensions: ['a.ts', 'b.ts'] } }));
    for (const name of ['a.ts', 'b.ts']) writeFileSync(join(pkg, name), 'export default function () {}');
    writeFileSync(join(f.global, 'settings.json'), JSON.stringify({ packages: [pkg] }));
    const catalog = await extensionCatalog(f.own);
    assert.equal(catalog.extensions.filter(extension => extension.name === 'pi-trim').length, 1);
    const resources = await executionResources([], f.own, 'planner');
    assert.equal(resources.args.filter(arg => arg === bundledTrim).length, 1);
    assert.ok(!resources.args.includes(join(pkg, 'a.ts')));
    assert.ok(!resources.args.includes(join(pkg, 'b.ts')));
  } finally { f.close(); }
});

test('production launcher loads selected extensions/tools/skills for Planner and Node only', { timeout: 90000 }, async () => {
  const f = fixture();
  try {
    writeFileSync(f.extension, `import { writeFileSync } from 'node:fs';
export default function (pi) {
  pi.registerTool({ name: 'global_probe', label: 'Probe', description: 'Global extension tool', parameters: {type:'object',properties:{}}, async execute() {return {content:[{type:'text',text:'ok'}],details:{}}} });
  pi.on('session_start', (_event, ctx) => writeFileSync(process.env.GRAPHER_TEST_RESULT, JSON.stringify({ tools: pi.getActiveTools(), commands: pi.getCommands().map(c => c.name), prompt: ctx.getSystemPrompt() })));
}`);
    for (const role of ['planner', 'node', 'partition', 'merger']) {
      const result = join(f.base, `${role}.json`);
      const args = ['--mode', 'rpc', '--no-session', '--no-context-files'];
      if (role === 'node') args.push('--approve');
      if (role === 'planner') args.push('--exclude-tools', 'edit,write,ls,find,grep');
      if (role === 'partition' || role === 'merger') args.push('--no-extensions', '--no-skills');
      const output = execFileSync(process.execPath, [join(root, 'engine/entrypoint.mjs'), ...args], {
        cwd: f.workspace, encoding: 'utf8', timeout: 20000,
        input: '{"id":"ready","type":"get_state"}\n',
        env: { ...process.env, PI_CODING_AGENT_DIR: f.own, GRAPHER_GLOBAL_PI_AGENT_DIR: f.global,
          GRAPHER_MODE: role, GRAPHER_TEST_RESULT: result, GRAPHER_ISOLATED_PI_MODELS: '1',
          GRAPHER_EXECUTION_KIND: 'source', PI_OFFLINE: '1' },
      });
      assert.ok(output.includes('"success":true'), output);
      const allowed = role === 'planner' || role === 'node';
      assert.equal(existsSync(result), allowed, `${role}: global extension execution`);
      if (allowed) {
        const state = JSON.parse(readFileSync(result, 'utf8'));
        assert.ok(state.tools.includes('global_probe'), `${role}: extension tools remain usable`);
        assert.ok(state.commands.includes('pi-trim'), `${role}: bundled trim loaded`);
        assert.match(state.prompt, /global-skill/, `${role}: global skills available`);
        if (role === 'planner') assert.ok(!state.tools.includes('write'));
      }
    }
  } finally { f.close(); }
});
