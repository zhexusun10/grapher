import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { createWorkspacePaths, registerWorkspacePaths } from '../backend/resources/workspace-paths.mjs';

test('virtual paths replace only the root prefix, preserving traversal and symlinks', async () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'grapher-paths-')));
  try {
    const repo = join(temp, 'repo with spaces');
    mkdirSync(repo);
    const paths = createWorkspacePaths(repo, repo);
    const virtual = paths.WORKSPACE_PATH;
    assert.equal(paths.physical(`${virtual}/../other`), `${repo}/../other`);
    assert.equal(paths.physical(`${virtual}/link/../file`), `${repo}/link/../file`);
    assert.equal(paths.physical(`${virtual}-other/file`), `${virtual}-other/file`);
    assert.equal(paths.physical('/etc/hosts'), '/etc/hosts');
    const command = paths.command(`cd "${virtual}/.." && pwd -P`);
    assert.equal(execFileSync('bash', ['-c', command], { encoding: 'utf8' }).trim(), temp);
    const hooks = new Map();
    registerWorkspacePaths({ on(name, callback) { hooks.set(name, callback); } }, repo, { originalRoot: repo });
    for (const path of ['../outside', '/etc/hosts', '.git/config', 'link/file', `${virtual}/../other`]) {
      const event = { toolName: 'read', input: { path } };
      assert.equal(await hooks.get('tool_call')(event), undefined);
      assert.equal(event.input.path, paths.physical(path));
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
