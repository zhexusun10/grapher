import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBundledWebSearch } from '../engine/pi-compat.ts';
import { withGrapherSearchPreferences } from '../engine/search-credentials.mjs';

async function fixture(run: (paths: { own: string; global: string; key: (directory: string, value: string) => void; execute: () => Promise<any>; sent: string[] }) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-search-credentials-'));
  const own = join(directory, 'own');
  const global = join(directory, 'global');
  mkdirSync(own); mkdirSync(global);
  const changes: Record<string, string | undefined> = {
    PI_CODING_AGENT_DIR: own, GRAPHER_GLOBAL_PI_AGENT_DIR: global,
    PI_BETTER_WEB_SEARCH_AUTH: undefined, GRAPHER_ISOLATED_PI_SEARCH: undefined,
    PI_BETTER_WEB_SEARCH_SETTINGS: join(own, 'settings.json'), PI_BETTER_WEB_SEARCH_CACHE: join(own, 'cache.json'),
    EXA_API_KEY: 'fake-environment-key',
  };
  const before = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(changes)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  writeFileSync(join(own, 'settings.json'), JSON.stringify({ version: 1, apis: { exa: true, deepseek: false, keenable: false, perplexity: false } }));
  const key = (target: string, value: string) => writeFileSync(join(target, 'better-web-search-auth.json'), JSON.stringify({ version: 1, keys: { exa: value } }));
  key(global, 'fake-inherited-key');
  const fetch = globalThis.fetch;
  const sent: string[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    assert.equal(String(url), 'https://api.exa.ai/search');
    sent.push(new Headers(init?.headers).get('x-api-key')!);
    return new Response(JSON.stringify({ results: [{ title: 'Example', url: 'https://example.com', highlights: ['Result'] }] }), { status: 200 });
  }) as typeof globalThis.fetch;
  try {
    const tools = new Map();
    const hooks = new Map();
    let active: string[] = [];
    await (await loadBundledWebSearch())({
      registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {},
      on: (event: string, handler: any) => hooks.set(event, handler),
      getActiveTools: () => active, setActiveTools: (next: string[]) => { active = next; },
    } as any);
    const ctx = { model: undefined, modelRegistry: { getAvailable: () => [], getProvider: () => undefined, getAll: () => [], hasConfiguredAuth: () => false } };
    const execute = async () => {
      await hooks.get('session_start')({}, ctx);
      assert.ok(active.includes('web_search'));
      return tools.get('web_search').execute('isolated-search', { query: 'official documentation' }, undefined, undefined, ctx);
    };
    await run({ own, global, key, execute, sent });
  } finally {
    globalThis.fetch = fetch;
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(directory, { recursive: true, force: true });
  }
}

test('bundled search inherits global Pi API keys, observes rotation and leaves source bytes unchanged', () => fixture(async ({ own, global, key, execute, sent }) => {
  const source = join(global, 'better-web-search-auth.json');
  const original = readFileSync(source, 'utf8');
  assert.notEqual((await execute()).isError, true);
  assert.equal(sent.at(-1), 'fake-inherited-key', 'saved Pi keys precede environment fallback');
  assert.equal(readFileSync(source, 'utf8'), original);
  key(global, 'fake-rotated-key');
  assert.notEqual((await execute()).isError, true);
  assert.equal(sent.at(-1), 'fake-rotated-key');
  key(own, 'fake-grapher-key');
  assert.notEqual((await execute()).isError, true);
  assert.equal(sent.at(-1), 'fake-grapher-key', 'Grapher-saved keys override inherited keys');
  assert.equal(JSON.parse(readFileSync(source, 'utf8')).keys.exa, 'fake-rotated-key');
  assert.equal(process.env.EXA_API_KEY, 'fake-environment-key', 'inherited keys never enter process environment values');
}));

test('explicit search credential paths and isolation opt out of inheritance; corrupt upstream data falls back safely', () => fixture(async ({ own, global, key, execute, sent }) => {
  process.env.GRAPHER_ISOLATED_PI_SEARCH = '1';
  await execute();
  assert.equal(sent.at(-1), 'fake-environment-key');
  delete process.env.GRAPHER_ISOLATED_PI_SEARCH;
  key(own, 'fake-explicit-key');
  process.env.PI_BETTER_WEB_SEARCH_AUTH = join(own, 'better-web-search-auth.json');
  await execute();
  assert.equal(sent.at(-1), 'fake-explicit-key');
  writeFileSync(process.env.PI_BETTER_WEB_SEARCH_AUTH, '{"version":1,"keys":{}}');
  await execute();
  assert.equal(sent.at(-1), 'fake-environment-key', 'an explicit path never borrows another directory');
  delete process.env.PI_BETTER_WEB_SEARCH_AUTH;
  writeFileSync(join(global, 'better-web-search-auth.json'), '{broken');
  await execute();
  assert.equal(sent.at(-1), 'fake-environment-key');
  assert.equal(readFileSync(join(global, 'better-web-search-auth.json'), 'utf8'), '{broken');
}));

test('Grapher Keenable public opt-in activates public endpoint until any of the 3 dedicated providers has an API key', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-keenable-public-'));
  const own = join(directory, 'own');
  const global = join(directory, 'global');
  mkdirSync(own); mkdirSync(global);
  const envKeys = [
    'PI_CODING_AGENT_DIR', 'GRAPHER_GLOBAL_PI_AGENT_DIR',
    'PI_BETTER_WEB_SEARCH_AUTH', 'GRAPHER_ISOLATED_PI_SEARCH',
    'PI_BETTER_WEB_SEARCH_SETTINGS', 'PI_BETTER_WEB_SEARCH_CACHE',
    'KEENABLE_API_KEY', 'EXA_API_KEY', 'PERPLEXITY_API_KEY', 'DEEPSEEK_API_KEY',
  ];
  const before = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  Object.assign(process.env, {
    PI_CODING_AGENT_DIR: own,
    GRAPHER_GLOBAL_PI_AGENT_DIR: global,
    PI_BETTER_WEB_SEARCH_SETTINGS: join(own, 'better-web-search-settings.json'),
    PI_BETTER_WEB_SEARCH_CACHE: join(own, 'better-web-search-cache.json'),
  });
  writeFileSync(join(own, 'extensions.json'), JSON.stringify({
    overrides: { 'npm:pi-better-web-search': true },
    webSearch: { keenablePublic: true },
  }));
  const fetch = globalThis.fetch;
  const requests: Array<{ url: string; apiKey: string | null; auth: string | null }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const target = String(url);
    const headers = new Headers(init?.headers);
    requests.push({ url: target, apiKey: headers.get('x-api-key'), auth: headers.get('authorization') });
    return new Response(JSON.stringify({ results: [{ title: 'Result', url: 'https://example.com' }] }), { status: 200 });
  }) as typeof globalThis.fetch;
  try {
    const tools = new Map();
    const hooks = new Map();
    let active: string[] = [];
    await (await loadBundledWebSearch())({
      registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {},
      on: (event: string, handler: any) => hooks.set(event, handler),
      getActiveTools: () => active, setActiveTools: (next: string[]) => { active = next; },
    } as any);
    const ctx = { model: undefined, modelRegistry: { getAvailable: () => [], getProvider: () => undefined, getAll: () => [], hasConfiguredAuth: () => false } };
    const run = async () => {
      await hooks.get('session_start')({}, ctx);
      assert.ok(active.includes('web_search'));
      return tools.get('web_search').execute('search-call', { query: 'grapher test' }, undefined, undefined, ctx);
    };

    // 1. No dedicated key -> uses Keenable public endpoint.
    assert.notEqual((await run()).isError, true);
    assert.equal(requests.at(-1)?.url, 'https://api.keenable.ai/v1/search/public');
    assert.equal(requests.at(-1)?.apiKey, null);

    // 2. Exa key configured -> stops using Keenable public endpoint and uses Exa.
    process.env.EXA_API_KEY = 'fake-exa-key';
    assert.notEqual((await run()).isError, true);
    assert.equal(requests.at(-1)?.url, 'https://api.exa.ai/search');
    assert.equal(requests.at(-1)?.apiKey, 'fake-exa-key');
    delete process.env.EXA_API_KEY;

    // 3. Perplexity key inherited from global Pi -> stops using Keenable public endpoint and uses Perplexity.
    writeFileSync(join(global, 'better-web-search-auth.json'), JSON.stringify({ version: 1, keys: { perplexity: 'fake-pplx-key' } }));
    assert.notEqual((await run()).isError, true);
    assert.equal(requests.at(-1)?.url, 'https://api.perplexity.ai/search');
    assert.equal(requests.at(-1)?.auth, 'Bearer fake-pplx-key');

    // 4. Keenable private key saved -> uses Keenable private endpoint (not /public).
    writeFileSync(join(global, 'better-web-search-auth.json'), JSON.stringify({ version: 1, keys: { keenable: 'fake-keenable-key' } }));
    assert.notEqual((await run()).isError, true);
    assert.equal(requests.at(-1)?.url, 'https://api.keenable.ai/v1/search');
    assert.equal(requests.at(-1)?.apiKey, 'fake-keenable-key');

    // 5. Explicit keenable: false in better-web-search-settings.json overrides Grapher's keenablePublic opt-in.
    writeFileSync(join(global, 'better-web-search-auth.json'), JSON.stringify({ version: 1, keys: {} }));
    writeFileSync(join(own, 'better-web-search-settings.json'), JSON.stringify({ version: 1, apis: { keenable: false } }));
    await hooks.get('session_start')({}, ctx);
    assert.ok(!active.includes('web_search'));
  } finally {
    globalThis.fetch = fetch;
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('withGrapherSearchPreferences does not leak synthetic keenable:true when unrelated preferences or other APIs are saved', () => {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-search-prefs-write-'));
  const envKeys = ['KEENABLE_API_KEY', 'EXA_API_KEY', 'PERPLEXITY_API_KEY'];
  const before = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  try {
    writeFileSync(join(directory, 'extensions.json'), JSON.stringify({
      overrides: { 'npm:pi-better-web-search': true },
      webSearch: { keenablePublic: true },
    }));
    let persisted: any = { version: 1 };
    const upstream = {
      readProviderPreferences: () => structuredClone(persisted),
      writeProviderPreferences: (next: any) => { persisted = structuredClone(next); return true; },
    };
    const credentials = { savedApiKey: () => undefined };
    const prefs = withGrapherSearchPreferences(upstream, credentials, () => directory);

    // 1. /web-search-provider pattern: mutates search while keeping same apis reference.
    const forProvider = prefs.readProviderPreferences();
    assert.equal(forProvider.apis?.keenable, true);
    forProvider.search = 'keenable';
    prefs.writeProviderPreferences(forProvider);
    assert.deepEqual(persisted, { version: 1, search: 'keenable', apis: undefined });

    // 2. /web-search-api deepseek or /pi-better-web-search login deepseek: spreads apis and changes another provider.
    const forOtherApi = prefs.readProviderPreferences();
    prefs.writeProviderPreferences({ ...forOtherApi, apis: { ...forOtherApi.apis, deepseek: true } });
    assert.deepEqual(persisted, { version: 1, search: 'keenable', apis: { deepseek: true } });

    // 3. Explicit /web-search-api keenable -> Enable: spreads apis and only keenable:true differs from disk.
    const forExplicitKeenable = prefs.readProviderPreferences();
    prefs.writeProviderPreferences({ ...forExplicitKeenable, apis: { ...forExplicitKeenable.apis, keenable: true } });
    assert.deepEqual(persisted, { version: 1, search: 'keenable', apis: { deepseek: true, keenable: true } });
  } finally {
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(directory, { recursive: true, force: true });
  }
});
