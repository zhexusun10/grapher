import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'grapher-upgrade-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const cleanupPowerShell = process.env.GRAPHER_TEST_POWERSHELL || (process.platform === 'win32'
  ? join(process.env.SystemRoot || 'C:\\Windows', process.arch === 'x64' ? 'SysWOW64' : 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : null);
const cleanupScript = join(root, 'src-tauri', 'nsis', 'stop-installation-runtime.ps1');

test('Windows upgrade cleanup preserves unrelated processes and fails closed on errors', {
  skip: !cleanupPowerShell,
}, () => {
  const result = execFileSync(cleanupPowerShell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', join(root, 'scripts', 'fixtures', 'windows-upgrade-cleanup.ps1'), '-CleanupScript', cleanupScript,
  ], { encoding: 'utf8', timeout: 30_000 });
  assert.match(result, /Scoped cleanup policy checks passed/);
});

test('Windows upgrade cleanup stops only the live backend in the selected installation', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const temp = tempDir(t);
  const install = join(temp, "Grapher user's & workspace 测试");
  const unrelated = join(temp, 'independent-cli');
  mkdirSync(join(install, 'runtime'), { recursive: true });
  mkdirSync(unrelated);
  const cmd = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  const executables = [join(install, 'runtime', 'grapher.exe'), join(install, 'Grapher.exe'), join(unrelated, 'grapher.exe')];
  const children = [];
  const exits = [];
  try {
    for (const file of executables) {
      copyFileSync(cmd, file);
      const child = spawn(file, ['/D', '/Q', '/K'], { cwd: temp, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
      children.push(child);
      exits.push(new Promise(resolve => child.once('close', resolve)));
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    }
    execFileSync(cleanupPowerShell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', cleanupScript, '-InstallDirectory', join(install, '.')], { encoding: 'utf8', timeout: 30_000 });
    let timer;
    try {
      await Promise.race([exits[0], new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Matching backend is still running')), 8000); })]);
    } finally { clearTimeout(timer); }
    assert.notEqual(children[0].exitCode, null);
    assert.equal(children[1].exitCode, null, 'The desktop GUI must not be matched by the backend cleanup');
    assert.equal(children[2].exitCode, null, 'The independent CLI must survive the upgrade');
    assert.ok(existsSync(executables[1]));
    assert.ok(existsSync(executables[2]));
  } finally {
    for (const child of children) { child.stdin?.destroy(); if (child.exitCode === null) child.kill(); }
    await Promise.all(exits);
  }
});
