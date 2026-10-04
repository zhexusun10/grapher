import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundledTrim, bundledContinuity, continuityId, extensionCatalog, executionResources, setExtensionEnabled, trimId } from '../engine/global-extensions.ts';
import { loadGrapherMcpConfig } from '../engine/mcp-config.ts';
import { loadMcpConfig } from '../engine/pi-compat.ts';

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

test('bundled continuity defaults on, supports persistent removal/restore and obeys role/CLI exclusions', async () => {
  const f = fixture();
  try {
    const settings = JSON.stringify({ extensions: ['-extensions/probe.ts'] });
    writeFileSync(join(f.global, 'settings.json'), settings);
    const continuity = (await extensionCatalog(f.own)).extensions.find(extension => extension.id === continuityId)!;
    assert.ok(continuity);
    assert.equal(continuity.path, bundledContinuity);
    assert.equal(continuity.bundled, true);
    assert.equal(continuity.required, false);
    assert.equal(continuity.enabled, true);
    assert.equal((await extensionCatalog(f.own)).extensions.find(extension => extension.id === trimId)?.required, true);
    for (const role of ['planner', 'node']) {
      assert.equal((await executionResources([], f.own, role)).args.filter(arg => arg === bundledContinuity).length, 1);
      for (const flag of ['--no-extensions', '-ne']) {
        assert.ok(!(await executionResources([flag], f.own, role)).args.includes(bundledContinuity));
      }
    }
    for (const role of ['partition', 'merger']) {
      assert.ok(!(await executionResources([], f.own, role)).args.includes(bundledContinuity));
    }
    const removed = await setExtensionEnabled(f.own, continuityId, false);
    assert.equal(removed.extensions.find(extension => extension.id === continuityId)?.enabled, false);
    assert.equal(JSON.parse(readFileSync(join(f.own, 'extensions.json'), 'utf8')).overrides[continuityId], false);
    for (const role of ['planner', 'node']) {
      const resources = await executionResources([], f.own, role);
      assert.ok(!resources.args.includes(bundledContinuity));
      assert.ok(resources.args.includes(bundledTrim), 'removal must not affect mandatory trim');
    }
    assert.equal((await extensionCatalog(f.own)).extensions.find(extension => extension.id === continuityId)?.enabled, false);
    await setExtensionEnabled(f.own, continuityId, true);
    assert.equal((await executionResources([], f.own, 'node')).args.filter(arg => arg === bundledContinuity).length, 1);
    assert.equal(readFileSync(join(f.global, 'settings.json'), 'utf8'), settings);
    assert.ok(existsSync(bundledContinuity), 'removal must not uninstall the bundled package');
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

for (const [name, bundled] of [['pi-trim', bundledTrim], ['pi-continuity', bundledContinuity]]) {
  test(`global/dedicated ${name} is deduplicated with the bundle, including multi-entry packages`, async () => {
    const f = fixture();
    try {
      const packages = [f.global, f.own].map(directory => {
        const pkg = join(directory, 'duplicate-package');
        mkdirSync(pkg);
        writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, pi: { extensions: ['a.ts', 'b.ts'] } }));
        for (const entry of ['a.ts', 'b.ts']) writeFileSync(join(pkg, entry), 'export default function () {}');
        writeFileSync(join(directory, 'settings.json'), JSON.stringify({ packages: [pkg] }));
        return pkg;
      });
      const catalog = await extensionCatalog(f.own);
      assert.equal(catalog.extensions.filter(extension => extension.name === name).length, 1);
      for (const enabled of name === 'pi-continuity' ? [true, false, true] : [true]) {
        if (name === 'pi-continuity') await setExtensionEnabled(f.own, continuityId, enabled);
        const resources = await executionResources([], f.own, 'planner');
        assert.equal(resources.args.filter(arg => arg === bundled).length, enabled ? 1 : 0);
        for (const pkg of packages) {
          assert.ok(!resources.args.includes(join(pkg, 'a.ts')));
          assert.ok(!resources.args.includes(join(pkg, 'b.ts')));
        }
      }
    } finally { f.close(); }
  });
}

test('Pi 1.0.1 project MCP overrides apply to external globals without moving credentials or editing files', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.workspace, '.pi'));
    const globalConfig = { mcpServers: { docs: { url: 'https://example.com/mcp', auth: { provider: 'anthropic' },
      headers: { Authorization: 'Bearer ${DOCS_TOKEN}' }, exposure: 'direct', toolExposure: { read: 'direct' },
      oauth: { clientRegistration: 'cimd' } } } };
    const projectConfig = { mcpServers: { docs: { enabled: false, exposure: 'hidden', toolExposure: { read: 'hidden' } } } };
    const globalFile = join(f.global, 'mcp.json');
    const projectFile = join(f.workspace, '.pi/mcp.json');
    writeFileSync(globalFile, JSON.stringify(globalConfig));
    writeFileSync(projectFile, JSON.stringify(projectConfig));
    const options = { globalDir: f.global, agentDir: f.own, cwd: f.workspace, projectTrusted: true };
    const loaded = loadGrapherMcpConfig(options);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.projectConfig, projectFile);
    assert.deepEqual(loaded.servers, [{ name: 'docs', config: { ...globalConfig.mcpServers.docs, ...projectConfig.mcpServers.docs },
      scope: 'global', source: globalFile, override: projectFile }]);
    const untrusted = loadGrapherMcpConfig({ ...options, projectTrusted: false });
    assert.equal(untrusted.projectConfig, undefined);
    assert.deepEqual(untrusted.servers[0].config, globalConfig.mcpServers.docs);
    assert.equal(readFileSync(globalFile, 'utf8'), JSON.stringify(globalConfig));
    assert.equal(readFileSync(projectFile, 'utf8'), JSON.stringify(projectConfig));
    assert.equal(existsSync(join(f.own, 'mcp.json')), false, 'global credentials must not be copied into Grapher config');
  } finally { f.close(); }
});

test('MCP precedence is global, dedicated, then trusted project; overrides inherit the dedicated definition', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.workspace, '.pi'));
    writeFileSync(join(f.global, 'mcp.json'), JSON.stringify({ autoEnableCodemode: true, mcpServers: {
      shared: { command: 'global', args: ['global-arg'] }, globalOnly: { command: 'global-only' },
    } }));
    writeFileSync(join(f.own, 'mcp.json'), JSON.stringify({ autoEnableCodemode: false, mcpServers: {
      shared: { command: 'dedicated', args: ['own-arg'], env: { TOKEN: '${TOKEN}' } }, ownOnly: { command: 'own-only' },
    } }));
    const projectFile = join(f.workspace, '.pi/mcp.json');
    writeFileSync(projectFile, JSON.stringify({ autoEnableCodemode: true, mcpServers: {
      shared: { enabled: false }, globalOnly: { command: 'project-replacement' }, ownOnly: { exposure: 'direct' },
    } }));
    const loaded = loadGrapherMcpConfig({ globalDir: f.global, agentDir: f.own, cwd: f.workspace, projectTrusted: true });
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.autoEnableCodemode, true);
    assert.deepEqual(loaded.servers[0].config, { command: 'dedicated', args: ['own-arg'], env: { TOKEN: '${TOKEN}' }, enabled: false });
    assert.equal(loaded.servers[0].source, join(f.own, 'mcp.json'));
    assert.equal(loaded.servers[0].override, projectFile);
    assert.equal(loaded.servers[1].scope, 'project');
    assert.deepEqual(loaded.servers[1].config, { command: 'project-replacement' });
    assert.equal(loaded.servers[2].config.exposure, 'direct');
    const untrusted = loadGrapherMcpConfig({ globalDir: f.global, agentDir: f.own, cwd: f.workspace, projectTrusted: false });
    assert.equal(untrusted.autoEnableCodemode, false);
    assert.equal(untrusted.servers[0].config.enabled, undefined);
  } finally { f.close(); }
});

test('MCP rejects invalid project overrides and provider-auth injection without changing global definitions', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.workspace, '.pi'));
    const base = { url: 'https://example.com/mcp', auth: { provider: 'anthropic' } };
    writeFileSync(join(f.global, 'mcp.json'), JSON.stringify({ mcpServers: { docs: base } }));
    const cases = [
      { mcpServers: { docs: { enabled: 'false' } } },
      { mcpServers: { docs: { exposure: 'invalid' } } },
      { mcpServers: { docs: { toolExposure: { read: 'invalid' } } } },
      { mcpServers: { docs: { auth: { provider: 'openai' } } } },
      { mcpServers: { docs: { headers: { Authorization: 'injected' } } } },
      { mcpServers: { docs: { args: ['injected'] } } },
      { mcpServers: { docs: { url: 'https://untrusted.example/mcp', auth: { provider: 'anthropic' } } } },
      { mcpServers: { missing: { enabled: false } } },
      { mcpServers: [] }, null,
    ];
    for (const config of cases) {
      writeFileSync(join(f.workspace, '.pi/mcp.json'), JSON.stringify(config));
      const loaded = loadGrapherMcpConfig({ globalDir: f.global, agentDir: f.own, cwd: f.workspace, projectTrusted: true });
      assert.equal(loaded.errors.length, 1, JSON.stringify(config));
      assert.deepEqual(loaded.servers.map(server => server.config), [base]);
      assert.equal(loaded.servers[0].override, undefined);
    }
    writeFileSync(join(f.workspace, '.pi/mcp.json'), '{');
    assert.equal(loadGrapherMcpConfig({ globalDir: f.global, agentDir: f.own, cwd: f.workspace, projectTrusted: true }).errors.length, 1);
  } finally { f.close(); }
});

test('MCP namespace collisions across global and dedicated directories are rejected', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.global, 'mcp.json'), JSON.stringify({ mcpServers: { 'my-server': { command: 'global' } } }));
    writeFileSync(join(f.own, 'mcp.json'), JSON.stringify({ mcpServers: { my_server: { command: 'dedicated' } } }));
    const loaded = loadGrapherMcpConfig({ globalDir: f.global, agentDir: f.own, cwd: f.workspace, projectTrusted: false });
    assert.equal(loaded.servers.length, 1);
    assert.match(loaded.errors[0], /conflicts with "my-server"/);
  } finally { f.close(); }
});

test('layered MCP loading matches upstream for a single agent directory, including errors and exposure aliases', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.workspace, '.pi'));
    writeFileSync(join(f.global, 'mcp.json'), JSON.stringify({ autoEnableCodemode: false, mcpServers: { docs: {
      command: 'probe', exposure: 'codemode-deferred', toolExposure: { read: 'direct' },
    } } }));
    for (const projectTrusted of [false, true]) {
      for (const patch of [{ enabled: false }, { exposure: 'codemode-deferred' }, { toolExposure: { read: 'hidden' } },
        { enabled: true }, { enabled: 'bad' }, { description: 'not an override' }]) {
        writeFileSync(join(f.workspace, '.pi/mcp.json'), JSON.stringify({ autoEnableCodemode: true, mcpServers: {
          docs: patch, extra: { command: 'extra' }, missing: { enabled: false },
        } }));
        assert.deepEqual(loadGrapherMcpConfig({ globalDir: f.global, agentDir: f.global, cwd: f.workspace, projectTrusted }),
          loadMcpConfig({ agentDir: f.global, cwd: f.workspace, projectTrusted }));
      }
    }
  } finally { f.close(); }
});

test('prepared native runtime includes continuity and respects the same removable selection', { timeout: 90000 }, async () => {
  const f = fixture();
  try {
    const runtime = execFileSync(process.execPath, [join(root, 'scripts/prepare-native-runtime.mjs')], {
      cwd: root, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, GRAPHER_NATIVE_RUNTIME_PARENT: f.base },
    }).trim();
    assert.ok(existsSync(join(runtime, 'node_modules/pi-continuity/extensions/index.ts')));
    assert.ok(existsSync(join(runtime, 'node_modules/pi-continuity/lib/continuity.ts')));
    const result = join(f.base, 'native-commands.json');
    writeFileSync(f.extension, `import { writeFileSync } from 'node:fs';
export default function (pi) {
  pi.on('session_start', () => writeFileSync(process.env.GRAPHER_TEST_RESULT, JSON.stringify(pi.getCommands().map(c => c.name))));
}`);
    for (const enabled of [true, false, true]) {
      await setExtensionEnabled(f.own, continuityId, enabled);
      const output = execFileSync(process.execPath, [join(runtime, 'engine/entrypoint.mjs'), '--mode', 'rpc', '--no-session', '--no-context-files'], {
        cwd: f.workspace, encoding: 'utf8', timeout: 20000, input: '{"id":"ready","type":"get_state"}\n',
        env: { ...process.env, PI_CODING_AGENT_DIR: f.own, GRAPHER_GLOBAL_PI_AGENT_DIR: f.global,
          GRAPHER_MODE: 'node', GRAPHER_TEST_RESULT: result, GRAPHER_ISOLATED_PI_MODELS: '1', PI_OFFLINE: '1' },
      });
      assert.ok(output.includes('"success":true'), output);
      const commands = JSON.parse(readFileSync(result, 'utf8'));
      assert.equal(commands.includes('pi-continuity'), enabled);
      assert.ok(commands.includes('pi-trim'));
    }
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
        assert.ok(state.commands.includes('pi-continuity'), `${role}: removable bundled continuity loaded`);
        assert.match(state.prompt, /global-skill/, `${role}: global skills available`);
        if (role === 'planner') assert.ok(!state.tools.includes('write'));
      }
    }
  } finally { f.close(); }
});
