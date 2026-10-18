import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { workspacePathMapper } from '../engine/workspace-tools.ts';
import { isCaseInsensitive } from '../engine/path-identity.mjs';

test('file tools map source aliases, file URLs and case/Unicode variants', () => {
  const root = mkdtempSync(join(tmpdir(), 'grapher-tool-paths-'));
  try {
    const source = join(root, 'SourceCase');
    const workspace = join(root, 'WorkspaceCase');
    mkdirSync(source);
    mkdirSync(workspace);
    const map = workspacePathMapper(workspace, source);
    assert.equal(map(join(source, 'marker')), join(workspace, 'marker'));
    assert.equal(map(pathToFileURL(join(source, 'marker')).href), join(workspace, 'marker'));
    if (process.platform === 'win32' && /^[A-Za-z]:\\/.test(source)) {
      const msys = `/${source[0].toLowerCase()}${source.slice(2).replaceAll('\\', '/')}`;
      assert.equal(map(`${msys}/marker`), join(workspace, 'marker'));
    }
    if (process.platform === 'darwin' || process.platform === 'win32') {
      assert.equal(isCaseInsensitive(workspace), true);
      assert.equal(map(join(source.toLowerCase(), 'marker')), join(workspace, 'marker'));
    }
    const unicodeSource = join(root, 'caf\u00e9');
    const unicodeWorkspace = join(root, 'ws\u00e9');
    mkdirSync(unicodeSource);
    mkdirSync(unicodeWorkspace);
    const unicodeMapped = workspacePathMapper(unicodeWorkspace, unicodeSource)(
      join(unicodeSource.normalize('NFD'), 'marker'),
    );
    if (process.platform === 'darwin') {
      // APFS resolves NFC/NFD to the same file.
      assert.equal(unicodeMapped, join(unicodeWorkspace, 'marker'));
    } else {
      // Linux and Windows keep distinct byte/code-unit names.
      assert.equal(unicodeMapped, join(unicodeSource.normalize('NFD'), 'marker'));
    }
    assert.equal(map(join(root, 'outside', 'marker')), join(root, 'outside', 'marker'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
