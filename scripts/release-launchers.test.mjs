// Generated release launchers must guide a first-time user without hiding
// failures: prerequisite checks, the opened URL, and visible exit codes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { launcherScripts, packageRelease } from './package-release.mjs';

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

test('macOS/Linux launcher checks Node version and Git, clears macOS quarantine, then execs Grapher', () => {
  for (const platform of ['macos', 'linux']) {
    const { files, executableScripts } = launcherScripts(platform, version);
    assert.deepEqual(executableScripts, ['start.sh']);
    const sh = files['start.sh'];
    assert.match(sh, /^#!\/bin\/sh\n/);
    assert.match(sh, /command -v node/);
    assert.match(sh, /Node\.js 22\.19 or newer is required/);
    assert.ok(sh.includes('[ "$node_major" -eq 22 ] && [ "$node_minor" -lt 19 ]'), 'version comparison must cover 22.x below 19');
    assert.match(sh, /command -v git/);
    assert.ok(sh.includes('case "$0" in */*)'), 'the launcher must locate its folder without external dirname so preflight works on a stripped PATH');
    assert.match(sh, /xattr -p com\.apple\.quarantine \.\/grapher/);
    assert.match(sh, platform === 'macos' ? /Darwin/ : /"Darwin"/);
    assert.match(sh, /http:\/\/127\.0\.0\.1:\$\{port\}/);
    assert.match(sh, /GRAPHER_PORT:-1421/);
    assert.match(sh, /exec \.\/grapher\n$/);
    assert.doesNotMatch(sh, /^\s*sudo /m, 'the launcher must only advise about system installers, never elevate itself');
  }
});

test('Windows launcher keeps the console open, verifies Node 22.19+ and Git, and honors GRAPHER_PORT', () => {
  const { files, executableScripts } = launcherScripts('windows', version);
  assert.deepEqual(executableScripts, ['start.bat']);
  const bat = files['start.bat'];
  assert.ok(bat.includes('\r\n'), 'start.bat must use CRLF line endings');
  assert.doesNotMatch(bat, /(?<!\r)\n/, 'start.bat must not contain bare LF line endings');
  assert.match(bat, /where node >nul 2>nul \|\| goto node-missing\r\n/);
  assert.match(bat, /process\.versions\.node/);
  assert.match(bat, /if %NODE_MAJOR% LSS 22 goto node-old\r\n/);
  assert.match(bat, /if %NODE_MAJOR% EQU 22 if %NODE_MINOR% LSS 19 goto node-old\r\n/);
  assert.match(bat, /if not defined NODE_MAJOR goto node-missing\r\n/);
  assert.match(bat, /where git >nul 2>nul \|\| goto git-missing\r\n/);
  assert.match(bat, /nodejs\.org/);
  assert.match(bat, /git-scm\.com\/download\/win/);
  assert.match(bat, /echo Grapher: http:\/\/127\.0\.0\.1:%PORT%/);
  assert.match(bat, /if not "%GRAPHER_PORT%"=="" set "PORT=%GRAPHER_PORT%"\r\n/);
  assert.match(bat, /grapher\.exe\r\n/);
  assert.match(bat, /pause\r\n/);
  assert.match(bat, /exit \/b %CODE%\r\n/);
});

test('in-package guide covers prerequisites, start, data and troubleshooting per platform', () => {
  const expected = ['## Requirements', '## Start', '## First run', '## Data and updates', '## Troubleshooting', version];
  for (const [platform, startMarker, extra] of [
    ['windows', 'start.bat', /SmartScreen[\s\S]*Run anyway/],
    ['macos', 'start.sh', /quarantine[\s\S]*xattr/],
    ['linux', 'start.sh', /bubblewrap/],
  ]) {
    const { files } = launcherScripts(platform, version);
    const guide = files['START-HERE.md'];
    for (const marker of expected) assert.ok(guide.includes(marker), `${platform}: ${marker}`);
    assert.match(guide, new RegExp(startMarker.replace('.', '\\.')));
    assert.match(guide, extra);
    assert.match(guide, /Node\.js 22\.19\+\*\* and \*\*Git\*\*/);
    assert.match(guide, /http:\/\/127\.0\.0\.1:1421/);
    assert.match(guide, /`.grapher\/`/);
  }
});

test('packaging rejects a target that does not match this host', () => {
  const host = { darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform];
  const other = host === 'windows' ? 'macos' : 'windows';
  assert.throws(() => packageRelease(other, process.arch, 'unused.zip'), /must match host/);
  assert.throws(() => packageRelease(host, 'other-arch', 'unused.zip'), /must match host/);
  assert.throws(() => packageRelease(host, process.arch, ''), /must match host/);
});
