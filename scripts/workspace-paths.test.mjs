import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createWorkspacePaths } from '../engine/workspace-paths.mjs';

test('literal shell mapping preserves quoting, external paths and opaque content', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'grapher-path-regression-')));
  try {
    const source = join(root, 'source');
    const workspace = join(root, "node ' space $literal");
    mkdirSync(source); mkdirSync(workspace);
    writeFileSync(join(workspace, 'marker'), 'NODE');
    const paths = createWorkspacePaths(workspace, source);
    const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
    for (const command of [
      `cat ${source}/marker`,
      `cat < ${source}/marker`,
      `cat ${source}/mark*`,
      `cat "$(printf %s ${source})/marker"`,
      `env PROJECT=${source} sh -c 'cat "$PROJECT/marker"'`,
      `bash -lc ${quote(`cat '${source}/marker'`)}`,
      `cat "${source}/marker"`,
      `cat '${source}/marker'`,
      `p='${source}'; cat "$p/marker"`,
      `sh -c ${quote(`cat '${source}/marker'`)}`,
    ]) assert.equal(execFileSync('bash', ['-c', paths.command(command)], { cwd: workspace, encoding: 'utf8' }), 'NODE');
    assert.equal(paths.command(`cat ${source}-other/marker`), `cat ${source}-other/marker`);
    assert.equal(paths.command('cat /etc/hosts'), 'cat /etc/hosts');
    assert.equal(paths.visible(`${workspace}/marker`), './marker');
    assert.equal(paths.visible(`${workspace}-other/marker`), `${workspace}-other/marker`);
    for (const encode of [
      value => value,
      value => JSON.stringify(value).slice(1, -1),
      value => value.replaceAll('/', '\\/'),
      value => value.replace(/[^a-zA-Z0-9_./-]/g, c => `\\${c}`),
      value => value.replaceAll("'", "'\\''"),
      value => pathToFileURL(value).href,
      value => encodeURI(value),
      value => encodeURIComponent(value),
    ]) {
      assert.equal(paths.visible(`${encode(workspace)}/marker`), `${encode(workspace).startsWith('file:') || encode(workspace).includes('%') ? encode(source) : '.'}/marker`);
    }
    assert.deepEqual(paths.view({ [workspace + '/marker']: workspace }), { ['./marker']: '.' });
    const fancySource = join(root, 'source with spaces');
    mkdirSync(fancySource);
    const alias = join(root, 'alias');
    const fancy = createWorkspacePaths(workspace, fancySource, alias);
    const escaped = fancySource.replaceAll(' ', '\\ ');
    for (const command of [
      `cat ${escaped}/marker`,
      `cat ${quote(fancySource + '/marker')}`,
      `ROOT=${escaped}; cat "$ROOT/marker"`,
      `cat ${alias}/marker`,
      `printf %s --input=${escaped}/marker`,
    ]) {
      const output = execFileSync('bash', ['-c', fancy.command(command)], { cwd: workspace, encoding: 'utf8' });
      assert.equal(output, command.startsWith('printf') ? `--input=${workspace}/marker` : 'NODE');
    }
    const opaque = [{type:'image', data:workspace}, {type:'thinking', thinking:workspace, signature:workspace}];
    assert.deepEqual(paths.view(opaque), opaque);
    assert.deepEqual(paths.view({id:workspace, textSignature:workspace, text:`Read ${workspace}/marker`}), {id:workspace, textSignature:workspace, text:'Read ./marker'});
  } finally { rmSync(root, {recursive:true, force:true}); }
});
