import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { workspacePathMapper } from '../engine/workspace-tools.ts';
import { createWorkspacePaths } from '../engine/workspace-paths.mjs';
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

test('file tools convert registered Git Bash mounts such as /tmp', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'grapher-tool-msys-'));
  try {
    const source = join(root, 'source');
    const workspace = join(root, 'workspace');
    const external = join(root, 'external');
    mkdirSync(source);
    mkdirSync(workspace);
    mkdirSync(external);
    createWorkspacePaths(workspace, source);
    const gitRoot = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
    const cygpath = join(gitRoot, '../../../usr/bin/cygpath.exe');
    const msysSource = execFileSync(cygpath, ['-u', source], { encoding: 'utf8' }).trim();
    const msysExternal = execFileSync(cygpath, ['-u', external], { encoding: 'utf8' }).trim();
    const map = workspacePathMapper(workspace, source);
    assert.equal(map(`${msysSource}/marker`), join(workspace, 'marker'));
    assert.equal(map(`${msysExternal}/data.csv`), join(external, 'data.csv'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
