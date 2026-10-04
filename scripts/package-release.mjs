// Build a relocatable distribution from the same verified runtime used by Graph.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { root } from './pi-baseline.mjs';

const [platform, arch, artifact] = process.argv.slice(2);
const host = { darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform];
if (platform !== host || arch !== process.arch || !artifact) {
  throw new Error(`Package target must match host ${host}-${process.arch}`);
}
const name = `grapher-${platform}-${arch}`;
const staging = mkdtempSync(join(tmpdir(), 'grapher-package-'));
const destination = join(staging, name);
const archive = resolve(artifact);
try {
  const runtime = execFileSync(process.execPath, [join(root, 'scripts/prepare-native-runtime.mjs')], {
    encoding: 'utf8', env: { ...process.env, GRAPHER_NATIVE_RUNTIME_PARENT: staging },
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
  renameSync(runtime, destination);
  const executable = platform === 'windows' ? 'grapher.exe' : 'grapher';
  cpSync(join(root, 'backend/target/release', executable), join(destination, executable));
  cpSync(join(root, 'dist'), join(destination, 'dist'), { recursive: true });
  for (const file of ['README.md', 'LICENSE', 'SECURITY.md']) cpSync(join(root, file), join(destination, file));
  writeFileSync(join(destination, 'start.sh'), '#!/bin/sh\nset -eu\ncd "$(dirname "$0")"\nexec ./grapher\n');
  chmodSync(join(destination, 'start.sh'), 0o755);
  writeFileSync(join(destination, 'start.bat'), '@echo off\r\ncd /d "%~dp0"\r\ngrapher.exe\r\n');
  mkdirSync(dirname(archive), { recursive: true });
  if (platform === 'windows') {
    // Compress-Archive silently skips hidden .git metadata. ZipFile includes it;
    // preparation dereferences Windows junctions before they reach the archive.
    execFileSync('powershell.exe', ['-NoProfile', '-Command',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:GRAPHER_PACKAGE_ROOT, $env:GRAPHER_PACKAGE_ARCHIVE, [IO.Compression.CompressionLevel]::Optimal, $true)'], {
      env: { ...process.env, GRAPHER_PACKAGE_ROOT: destination, GRAPHER_PACKAGE_ARCHIVE: archive }, stdio: 'inherit',
    });
  } else {
    execFileSync('tar', ['czf', archive, '-C', staging, name], { stdio: 'inherit' });
  }
  console.log(`Packaged ${basename(archive)}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
