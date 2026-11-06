import assert from 'node:assert/strict';
import { test } from 'node:test';
import { piExtensions } from '../src/services/piExtensions.ts';

test('extension settings use local JSON POSTs and return the persisted remove/add catalogs', async () => {
  const original = globalThis.fetch;
  const extension = { id: 'global/probe.ts', name: 'probe', enabled: true, bundled: false, required: false, source: 'auto', path: 'global/probe.ts' };
  const requests: any[] = [];
  globalThis.fetch = (async (url, init) => {
    assert.equal(url, '/api/pi_extensions');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.cache, 'no-store');
    assert.deepEqual(init?.headers, { 'Content-Type': 'application/json' });
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    if (body.operation === 'set_enabled') extension.enabled = body.enabled;
    return new Response(JSON.stringify({ result: { globalDirectory: 'global', extensions: [extension] } }));
  }) as typeof fetch;
  try {
    assert.equal((await piExtensions.catalog()).extensions[0].enabled, true);
    assert.equal((await piExtensions.setEnabled(extension.id, false)).extensions[0].enabled, false);
    assert.equal((await piExtensions.setEnabled(extension.id, true)).extensions[0].enabled, true);
    assert.deepEqual(requests, [
      { version: 1, operation: 'catalog' },
      { version: 1, operation: 'set_enabled', id: extension.id, enabled: false },
      { version: 1, operation: 'set_enabled', id: extension.id, enabled: true },
    ]);
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Cannot read global settings' }), { status: 400 });
    await assert.rejects(piExtensions.catalog(true), /Cannot read global settings/);
  } finally { globalThis.fetch = original; }
});

test('a reopened Settings card reads the page-session catalog instead of repainting a placeholder', async () => {
  const original = globalThis.fetch;
  const extension = { id: 'global/probe.ts', name: 'probe', enabled: true, bundled: false, required: false, source: 'auto', path: 'global/probe.ts' };
  let reads = 0;
  globalThis.fetch = (async () => {
    reads += 1;
    return new Response(JSON.stringify({ result: { globalDirectory: 'global', extensions: [extension] } }));
  }) as typeof fetch;
  try {
    const catalog = await piExtensions.catalog(true);
    assert.equal(reads, 1);
    // Reopening Settings must render the rows the reader already saw: the cached
    // catalog is served without a request, so the card never paints a shorter
    // placeholder and the pane never grows under a reader scrolled to the end.
    assert.equal(piExtensions.getCachedCatalog(), catalog);
    assert.equal(await piExtensions.catalog(), catalog);
    assert.equal(reads, 1);
    // The refresh control still bypasses the cache.
    await piExtensions.catalog(true);
    assert.equal(reads, 2);
    // A failed background refresh keeps the last good catalog on screen.
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
    await assert.rejects(piExtensions.catalog(true), /boom/);
    assert.equal(piExtensions.getCachedCatalog()?.extensions[0].id, extension.id);
  } finally { globalThis.fetch = original; }
});
