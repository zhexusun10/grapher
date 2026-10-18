import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createWorkspacePaths, VISIBLE_ROOT, visibleWindowsRoots } from '../engine/workspace-paths.mjs';
import { actualPath, isCaseInsensitive, pathKey, pathWithin, samePath } from '../engine/path-identity.mjs';

test('Windows visible paths use forward slashes for Bash and JSON spellings', () => {
  assert.equal(visibleWindowsRoots(`${VISIBLE_ROOT}\\a\\b`), './a/b');
  assert.equal(visibleWindowsRoots(`${VISIBLE_ROOT}\\\\a\\\\b`), './a/b');
  assert.equal(visibleWindowsRoots(`${VISIBLE_ROOT}/a/b`), './a/b');
  assert.equal(visibleWindowsRoots(`${VISIBLE_ROOT}//a//b`), './a/b');
  assert.equal(visibleWindowsRoots(VISIBLE_ROOT), '.');
});

test('literal shell mapping preserves quoting, external paths and opaque content', { skip: process.platform === 'win32' }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'grapher-path-regression-')));
  try {
    const source = join(root, 'source');
    const workspace = join(root, "node ' space $literal");
    mkdirSync(source); mkdirSync(workspace);
    writeFileSync(join(workspace, 'marker'), 'NODE');
    const paths = createWorkspacePaths(workspace, source);
    assert.equal(actualPath(`${workspace}/marker`), `${workspace}/marker`);
    assert.equal(pathWithin(`${workspace}/marker`, workspace), true);
    const sourceLink = join(root, 'source-link');
    symlinkSync(source, sourceLink, 'dir');
    assert.equal(samePath(sourceLink, source), true);
    assert.equal(pathKey(sourceLink), pathKey(source));
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
    assert.equal(paths.command(`cat ${source}/../source-other/marker`), `cat ${source}/../source-other/marker`);
    assert.equal(paths.command(`cat ${source}/../source/marker`), `cat ${quote(workspace + '/marker')}`);
    assert.equal(paths.command(`cc -I${source}/include`), `cc -I${quote(workspace + '/include')}`);
    assert.equal(paths.command('cat /etc/hosts'), 'cat /etc/hosts');
    assert.equal(paths.visible(`${workspace}/marker`), './marker');
    assert.equal(paths.visible(`${workspace}-other/marker`), `${workspace}-other/marker`);
    if (isCaseInsensitive(workspace)) {
      assert.equal(paths.visible(`${workspace.toLowerCase()}/marker`), './marker');
      assert.equal(samePath(workspace, workspace.toLowerCase()), true);
      assert.equal(paths.physical(`${source.toLowerCase()}/marker`), join(workspace, 'marker'));
    }
    const unicodeName = 'caf\u00e9';
    const unicodePath = join(root, unicodeName);
    mkdirSync(unicodePath);
    if (process.platform === 'darwin') {
      // APFS is normalization-insensitive even on case-sensitive volumes.
      assert.equal(pathKey(unicodePath), pathKey(unicodePath.normalize('NFD')));
    } else {
      // Linux and Windows treat NFC and NFD names as distinct paths.
      assert.notEqual(pathKey(unicodePath), pathKey(unicodePath.normalize('NFD')));
    }
    const fileUrl = pathToFileURL(join(workspace, 'marker')).href;
    assert.equal(paths.visible(fileUrl).endsWith('/marker'), true);
    assert.equal(paths.visible(fileUrl).startsWith('file:'), true);
    const mappedUrl = paths.command(`cat ${pathToFileURL(join(source, 'marker')).href}`);
    assert.equal(mappedUrl.startsWith('cat file:'), true);
    assert.equal(mappedUrl.includes("file://'"), false);
    assert.equal(mappedUrl.includes("file:/'"), false);
    const otherUrl = pathToFileURL(source + '-other/marker').href;
    assert.equal(paths.command(`cat ${otherUrl}`), `cat ${otherUrl}`);
    assert.equal(paths.command(`cat https://example.invalid${source}/marker`),
      `cat https://example.invalid${source}/marker`);
    assert.equal(paths.command(`scp ${source}/marker host:${source}/marker`),
      `scp ${quote(workspace + '/marker')} host:${source}/marker`);
    assert.equal(paths.command(`cat <<EOF\n${source}/marker\nEOF`),
      `cat <<EOF\n${source}/marker\nEOF`);
    const extra = join(root, 'extra workspace');
    mkdirSync(extra);
    const withExtra = createWorkspacePaths(workspace, source, source, [extra]);
    assert.equal(withExtra.visible(`${extra}/marker`), './marker');
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

test('Windows workspace mapping preserves native and slash paths without requiring a POSIX shell', { skip: process.platform !== 'win32' }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'grapher-path-regression-')));
  try {
    const source = join(root, 'source');
    const workspace = join(root, 'node with spaces');
    mkdirSync(source); mkdirSync(workspace);
    const paths = createWorkspacePaths(workspace, source);
    const slashSource = source.replaceAll('\\', '/');
    const slashWorkspace = workspace.replaceAll('\\', '/');
    assert.equal(actualPath(join(workspace, 'marker')), join(workspace, 'marker'));
    assert.equal(pathWithin(join(workspace, 'marker'), workspace), true);
    assert.equal(pathWithin(join(root, 'outside', 'marker'), workspace), false);
    assert.equal(pathWithin(`${source[0]}:\\Windows`, `${source[0]}:\\`), true);
    assert.equal(samePath(pathToFileURL(source).href, source), true);
    const msysSource = `/${source[0].toLowerCase()}${source.slice(2).replaceAll('\\', '/')}`;
    assert.equal(samePath(msysSource, source), true);
    if (process.platform === 'win32') {
      const junction = join(root, 'source-link');
      symlinkSync(source, junction, 'junction');
      assert.equal(samePath(junction, source), true);
      assert.equal(pathKey(junction), pathKey(source));
      assert.equal(actualPath(join(junction, 'missing', 'leaf')),
        join(realpathSync(source), 'missing', 'leaf'));
    }
    assert.equal(paths.physical(join(source, 'marker')), join(workspace, 'marker'));
    assert.equal(paths.physical(pathToFileURL(join(source, 'marker')).href), join(workspace, 'marker'));
    assert.equal(paths.visible(join(workspace, 'marker')), './marker');
    assert.equal(paths.visible(`${workspace.replaceAll('\\', '\\\\')}/marker`), './marker');
    const sourceUri = pathToFileURL(source).href;
    assert.equal(paths.visible(`${pathToFileURL(workspace).href}/marker`), `${sourceUri}/marker`);
    assert.equal(createWorkspacePaths(source, source).visible(sourceUri), sourceUri,
      'source-native and private turns must retain the same valid file URI');
    assert.equal(paths.visible(`${slashWorkspace}/marker`), './marker');
    assert.equal(paths.command(`cat ${slashSource}/marker`), `cat '${slashWorkspace}/marker'`);
    // Native unquoted spellings and attached options exercise Windows path
    // tokenization without a POSIX shell escape pass.
    assert.equal(paths.command(`cat ${source}/marker`), `cat '${slashWorkspace}/marker'`);
    assert.equal(paths.command(`cc -I${source}/include`), `cc -I'${slashWorkspace}/include'`);
    assert.equal(paths.command(`cat ${source}/./marker`), `cat '${slashWorkspace}/marker'`);
    assert.equal(paths.command(`cat ${source}/../source/marker`), `cat '${slashWorkspace}/marker'`);
    assert.equal(paths.command(`cat ${slashSource}/../source/marker`), `cat '${slashWorkspace}/marker'`);
    assert.equal(paths.command(`cat ${source}/../source-other/marker`), `cat ${source}/../source-other/marker`);
    assert.equal(paths.command(`cat ${source}/../source/mark*`), `cat ${source}/../source/mark*`);
    const nestedAlias = join(source, 'nested');
    mkdirSync(nestedAlias);
    const nested = createWorkspacePaths(workspace, source, nestedAlias);
    assert.equal(nested.command(`cat ${nestedAlias}/marker`), `cat '${slashWorkspace}/marker'`);
    assert.equal(nested.physical(`${nestedAlias}/marker`), join(workspace, 'marker'));
    assert.equal(paths.command(`cat ${slashSource}-other/marker`), `cat ${slashSource}-other/marker`);
    assert.deepEqual(paths.view({ [join(workspace, 'marker')]: workspace }), { './marker': '.' });
    const extendedSource = `\\\\?\\${source}`;
    const extendedWorkspace = `\\\\?\\${workspace}`;
    const canonical = createWorkspacePaths(extendedWorkspace, extendedSource, source);
    const driveSource = slashSource.replace(/^([A-Za-z]):\//, (_, drive) => `/${drive.toLowerCase()}/`);
    const cygdriveSource = slashSource.replace(/^([A-Za-z]):\//, (_, drive) => `/cygdrive/${drive.toLowerCase()}/`);
    for (const prefix of [source, slashSource, extendedSource, extendedSource.replaceAll('\\', '/'), driveSource, cygdriveSource]) {
      assert.equal(canonical.physical(`${prefix}/marker`), join(workspace, 'marker'));
      assert.equal(canonical.physical(`${prefix}-other/marker`), `${prefix}-other/marker`);
    }
    assert.equal(canonical.command(`cat '${extendedSource}/marker'`), `cat '${slashWorkspace}/marker'`);
    assert.equal(canonical.command(`cat '${cygdriveSource}/marker'`), `cat '${slashWorkspace}/marker'`);
    const doubledSource = source.replaceAll('\\', '\\\\');
    assert.equal(canonical.physical(`${doubledSource}/marker`), join(workspace, 'marker'));
    assert.equal(canonical.command(`cat '${doubledSource}/marker'`), `cat '${slashWorkspace}/marker'`);
    assert.equal(canonical.command(`cat ${pathToFileURL(join(source, 'marker')).href}`),
      `cat ${pathToFileURL(join(workspace, 'marker')).href}`);
    if (isCaseInsensitive(workspace)) {
      assert.equal(paths.visible(`${workspace.toLowerCase()}/marker`), './marker');
      assert.equal(canonical.physical(`${source.toLowerCase()}/marker`), join(workspace, 'marker'));
      assert.equal(canonical.command(`cat ${source.toLowerCase()}/marker`), `cat '${slashWorkspace}/marker'`);
    }
    // A batch `cygpath -u -p` can mis-split a path containing ';'. The per-value
    // fallback must still map the workspace instead of caching a partial batch.
    const semicolon = join(root, 'work;space with spaces');
    mkdirSync(semicolon);
    const semicolonPaths = createWorkspacePaths(semicolon, source);
    assert.equal(semicolonPaths.physical(`${source}/marker`), join(semicolon, 'marker'));
    assert.equal(semicolonPaths.visible(`${semicolon}/marker`), './marker');
    assert.equal(semicolonPaths.command(`cat ${source}/marker`),
      `cat '${semicolon.replaceAll('\\', '/')}/marker'`);
    const gitRoot = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
    const cygpath = join(gitRoot, '../../../usr/bin/cygpath.exe');
    const bashWorkspace = execFileSync(cygpath, ['-u', workspace], { encoding: 'utf8' }).trim();
    const bashSource = execFileSync(cygpath, ['-u', source], { encoding: 'utf8' }).trim();
    const semicolonSource = execFileSync(cygpath, ['-u', source], { encoding: 'utf8' }).trim();
    const semicolonWorkspace = execFileSync(cygpath, ['-u', semicolon], { encoding: 'utf8' }).trim();
    assert.equal(semicolonPaths.physical(`${semicolonSource}/marker`), join(semicolon, 'marker'));
    assert.equal(semicolonPaths.command(`cat ${semicolonSource}/marker`),
      `cat '${semicolon.replaceAll('\\', '/')}/marker'`);
    assert.equal(semicolonPaths.visible(`${semicolonWorkspace}/marker`), './marker');
    assert.equal(canonical.visible(`${bashWorkspace}/marker`), './marker');
    assert.equal(canonical.physical(`${bashSource}/marker`), join(workspace, 'marker'));
    assert.equal(canonical.command(`cat '${bashSource}/marker'`), `cat '${slashWorkspace}/marker'`);
    const aliasPrefix = bashSource.startsWith('/tmp/') ? ['/tmp/', 'C:\\tmp\\']
      : bashSource.startsWith('/cygdrive/') ? ['/cygdrive/', 'C:\\cygdrive\\']
        : bashSource.startsWith('/c/') ? ['/c/', 'C:\\c\\'] : null;
    if (aliasPrefix) {
      const fakeNative = `${aliasPrefix[1]}${bashSource.slice(aliasPrefix[0].length).replaceAll('/', '\\')}\\marker`;
      assert.equal(canonical.physical(fakeNative), fakeNative);
      assert.equal(canonical.command(`cat ${fakeNative}`), `cat ${fakeNative}`);
      assert.equal(canonical.physical(`${bashSource}-other/marker`), `${bashSource}-other/marker`);
      assert.equal(canonical.command(`cat ${bashSource}-other/marker`), `cat ${bashSource}-other/marker`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
