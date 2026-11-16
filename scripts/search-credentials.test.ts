import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBundledWebSearch } from '../engine/pi-compat.ts';

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
