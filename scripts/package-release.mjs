// Build a relocatable distribution from the same verified runtime used by Graph.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from './pi-baseline.mjs';

const host = { darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform];
const docsUrl = 'https://github.com/zhexusun10/grapher/tree/main/docs';

// Generated launcher files. Grapher itself is prebuilt; agent processes and
// provider login still run through the Node.js and Git on the user's PATH, so
// the launchers check both and fail with actionable guidance, never a silent
// crash or a vanished console window.
export function launcherScripts(platform, version) {
  const requirements = [
    '- **Node.js 22.19+** and **Git** on `PATH`. Agent processes and provider login run through them at runtime; the start script checks both and prints exact guidance when something is missing.',
  ];
  const startHere = [
    `# Grapher ${version} — quick start`,
    '',
    'This archive is a compiled, relocatable Grapher installation: prebuilt backend, frontend, pinned Pi runtime and bundled extensions. No Rust toolchain, npm install or compilation is needed here.',
    '',
    '## Requirements',
    '',
    ...requirements,
    platform === 'windows'
      ? '- Windows: Git for Windows (it includes the Bash that tasks run in).'
      : platform === 'linux'
        ? '- Linux Graph runs: `bubblewrap` plus permitted unprivileged user/mount/PID namespaces.'
        : '- macOS: nothing extra; Graph isolation uses the built-in Seatbelt support.',
    '',
    '## Start',
    '',
    platform === 'windows'
      ? [
          '- Double-click `start.bat` (or run it in a terminal). The first launch may show a SmartScreen prompt for the unsigned binary — choose **More info** → **Run anyway**.',
        ]
      : [
          '- Run `./start.sh` in a terminal. On macOS it removes Apple\'s download quarantine mark from this extracted folder automatically.',
        ],
    '',
    'Then open **http://127.0.0.1:1421** (set `GRAPHER_PORT` to use another port and start again).',
    '',
    '## First run',
    '',
    '1. Open **Settings**, select a local project directory, and authenticate a provider (see the repository\'s Providers guide).',
    '2. Enter a coding goal; Auto picks Serial or Graph. Approve the Graph plan before execution.',
    '3. Results are complete only after they are published back into your project.',
    '',
    platform === 'windows'
      ? '**Use trusted projects only; start with a disposable one.** Planner Bash writes reach your project before approval, and Windows workspaces are not filesystem sandboxes. See the security notes in the repository README.'
      : '**Use trusted projects only; start with a disposable one.** Planner Bash writes reach your project before approval. Graph workspaces use the macOS/Linux filesystem boundary, but related host paths remain reachable. See the security notes in the repository README.',
    '',
    '## Data and updates',
    '',
    '- Runtime data lives in `.grapher/` inside this folder. Back it up before replacing an installation.',
    '- To update: extract the new archive into a new folder and move your `.grapher/` data over.',
    '',
    '## Troubleshooting',
    '',
    '| Symptom | Fix |',
    '| --- | --- |',
    '| "Node.js/Git was not found on PATH" | Install the missing tool (links in the launcher message), reopen the terminal, run again |',
    '| Port already in use | Stop the other process or set `GRAPHER_PORT` before starting |',
    ...(platform === 'macos'
      ? [
          '| macOS blocks the binary | Right-click `grapher` → Open, or run `xattr -dr com.apple.quarantine .` here |',
          '| Wrong macOS download | `uname -m` shows `arm64` (Apple Silicon) or `x64` (Intel); pick the matching archive |',
        ]
      : platform === 'linux'
        ? ['| Wrong architecture | `uname -m` shows `x86_64` or `aarch64`; pick the matching archive |']
        : []),
    '',
    `Full documentation: ${docsUrl}`,
    '',
  ].join('\n');

  if (platform === 'windows') {
    const bat = [
      '@echo off',
      'setlocal',
      'cd /d "%~dp0"',
      'title Grapher',
      '',
      'where node >nul 2>nul || goto node-missing',
      'for /f "tokens=1,2 delims=. " %%a in (\'node -p "process.versions.node"\') do (',
      '    set "NODE_MAJOR=%%a"',
      '    set "NODE_MINOR=%%b"',
      ')',
      'if not defined NODE_MAJOR goto node-missing',
      'if %NODE_MAJOR% LSS 22 goto node-old',
      'if %NODE_MAJOR% EQU 22 if %NODE_MINOR% LSS 19 goto node-old',
      'where git >nul 2>nul || goto git-missing',
      '',
      'set "PORT=1421"',
      'if not "%GRAPHER_PORT%"=="" set "PORT=%GRAPHER_PORT%"',
      'echo Grapher: http://127.0.0.1:%PORT%  (press Ctrl+C or close this window to stop)',
      'echo.',
      'grapher.exe',
      'set "CODE=%ERRORLEVEL%"',
      'echo.',
      'echo Grapher exited with code %CODE%.',
      'pause',
      'exit /b %CODE%',
      '',
      ':node-old',
      'echo [ERROR] Node.js 22.19 or newer is required (found an older version on PATH).',
      'echo Install the current LTS from https://nodejs.org/ , reopen this window, then run start.bat again.',
      'pause',
      'exit /b 1',
      '',
      ':node-missing',
      'echo [ERROR] Node.js 22.19+ was not found on PATH.',
      'echo Install the current LTS from https://nodejs.org/ , reopen this window, then run start.bat again.',
      'pause',
      'exit /b 1',
      '',
      ':git-missing',
      'echo [ERROR] Git was not found on PATH.',
      'echo Install Git for Windows from https://git-scm.com/download/win (it includes the Bash that tasks run in),',
      'echo reopen this window, then run start.bat again.',
      'pause',
      'exit /b 1',
      '',
    ].join('\r\n');
    return { files: { 'start.bat': bat, 'START-HERE.md': startHere }, executableScripts: ['start.bat'] };
  }

  const sh = [
    '#!/bin/sh',
    '# Grapher release launcher (macOS/Linux). Grapher itself is prebuilt; agent',
    '# processes and provider login still use the Node.js and Git on PATH.',
    'set -eu',
    'case "$0" in */*) cd "${0%/*}" ;; esac',
    '',
    'port="${GRAPHER_PORT:-1421}"',
    '',
    'if ! command -v node >/dev/null 2>&1; then',
    '  echo "[ERROR] Node.js 22.19+ was not found on PATH." >&2',
    '  echo "Install the current LTS from https://nodejs.org/ (macOS also: brew install node), reopen the terminal, then run ./start.sh again." >&2',
    '  exit 1',
    'fi',
    'node_version="$(node -p \'process.versions.node\' 2>/dev/null || echo 0)"',
    'node_major="${node_version%%.*}"',
    'node_minor="${node_version#*.}"; node_minor="${node_minor%%.*}"; node_minor="${node_minor:-0}"',
    'if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 19 ]; }; then',
    '  echo "[ERROR] Node.js 22.19 or newer is required (found ${node_version} on PATH)." >&2',
    '  echo "Install the current LTS from https://nodejs.org/ (macOS also: brew install node), reopen the terminal, then run ./start.sh again." >&2',
    '  exit 1',
    'fi',
    'if ! command -v git >/dev/null 2>&1; then',
    '  echo "[ERROR] Git was not found on PATH." >&2',
    '  echo "Install Git (macOS: xcode-select --install or brew install git; Debian/Ubuntu: sudo apt-get install git), reopen the terminal, then run ./start.sh again." >&2',
    '  exit 1',
    'fi',
    '',
    '# Downloaded archives carry Apple\'s quarantine mark; remove it inside this',
    '# extracted folder only, so Gatekeeper does not kill the unsigned binary.',
    'if [ "$(uname)" = "Darwin" ] && command -v xattr >/dev/null 2>&1 \\',
    '   && xattr -p com.apple.quarantine ./grapher >/dev/null 2>&1; then',
    '  echo "Removing the macOS download quarantine mark from this extracted copy..."',
    '  xattr -dr com.apple.quarantine . >/dev/null 2>&1 || true',
    'fi',
    '',
    'echo "Grapher: http://127.0.0.1:${port}  (press Ctrl+C to stop)"',
    'exec ./grapher',
    '',
  ].join('\n');
  return { files: { 'start.sh': sh, 'START-HERE.md': startHere }, executableScripts: ['start.sh'] };
}

export function packageRelease(platform, arch, artifact) {
  if (platform !== host || arch !== process.arch || !artifact) {
    throw new Error(`Package target must match host ${host}-${process.arch}`);
  }
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
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
    const { files, executableScripts } = launcherScripts(platform, version);
    for (const [fileName, content] of Object.entries(files)) {
      writeFileSync(join(destination, fileName), content);
    }
    for (const script of executableScripts) chmodSync(join(destination, script), 0o755);
    mkdirSync(dirname(archive), { recursive: true });
    // Repackaging over a previous artifact must not fail (CreateFromDirectory
    // refuses to overwrite; tar's czf already replaces).
    rmSync(archive, { force: true });
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
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [platform, arch, artifact] = process.argv.slice(2);
  try {
    packageRelease(platform, arch, artifact);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
