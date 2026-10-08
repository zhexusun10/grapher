// Explicit, disposable native ML test tooling. Never imports host pip/Conda
// settings, credentials, or registers Python/PATH. No package download in tests.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, stat, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) throw new Error(`Required: ${name}`); return args[i + 1]; };
const directory = resolve(option('--directory'));
const backend = option('--backend');
if (!['cpu', 'cuda', 'mps', 'rocm'].includes(backend)) throw new Error('Choose an explicit native device backend');
if (process.arch !== 'x64' && process.arch !== 'arm64') throw new Error('Unverified native ML architecture');
if (backend === 'cuda' && !['linux', 'win32'].includes(process.platform) || backend === 'mps' && process.platform !== 'darwin' || backend === 'rocm' && process.platform !== 'linux') throw new Error('Backend does not match native host; no OS fallback');
const platform = { win32: 'Windows', linux: 'Linux', darwin: 'MacOSX' }[process.platform];
if (!platform) throw new Error('Native host unsupported');
const arch = process.arch === 'x64' ? 'x86_64' : process.platform === 'darwin' ? 'arm64' : 'aarch64';
const version = '25.3.1-0';
const filename = `Miniforge3-${version}-${platform}-${arch}.${process.platform === 'win32' ? 'exe' : 'sh'}`;
const url = `https://github.com/conda-forge/miniforge/releases/download/${version}/${filename}`;
const marker = join(directory, 'grapher-ml-tools.json');
const identity = { schema: 1, platform: process.platform, arch: process.arch, backend, miniforge: version, torch: '2.8.0', numpy: '2.3.1' };
await mkdir(directory, { recursive: true });
const entries = await readdir(directory);
if (entries.length) {
  const saved = JSON.parse(await readFile(marker, 'utf8').catch(() => { throw new Error('Refusing an existing unowned tool directory'); }));
  if (JSON.stringify(saved) !== JSON.stringify(identity)) throw new Error('Tool identity differs; use a new disposable directory');
} else await writeFile(marker, JSON.stringify(identity), { flag: 'wx' });
const home = join(directory, 'home'); const prefix = join(directory, 'miniforge'); const wheels = join(directory, 'wheels');
await mkdir(home, { recursive: true }); await mkdir(wheels, { recursive: true });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'ProgramFiles', 'ProgramFiles(x86)', 'TEMP', 'TMP', 'TMPDIR', 'LANG'].some(name => name.toLowerCase() === key.toLowerCase())));
Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData/Roaming'), LOCALAPPDATA: join(home, 'AppData/Local'), CONDARC: join(directory, 'condarc'), CONDA_PKGS_DIRS: join(prefix, 'pkgs'), PYTHONUTF8: '1', PIP_CONFIG_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null' });
await mkdir(env.APPDATA, { recursive: true }); await mkdir(env.LOCALAPPDATA, { recursive: true });
await writeFile(env.CONDARC, 'channels:\n  - conda-forge\nauto_activate_base: false\n');
async function hash(path) {
  const digest = createHash('sha256'); for await (const chunk of createReadStream(path)) digest.update(chunk); return digest.digest('hex');
}
async function download(url, path) {
  // Public HTTPS only, no .netrc, curlrc or auth environment.
  const pending = path + '.pending';
  const response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  const { pipeline } = await import('node:stream/promises'); const { createWriteStream } = await import('node:fs');
  await pipeline(response.body, createWriteStream(pending, { flags: 'w' })); await rename(pending, path);
}
async function run(program, argv) {
  await new Promise((done, fail) => {
    const child = spawn(program, argv, { env, cwd: directory, stdio: 'inherit' });
    child.once('error', fail); child.once('exit', code => code === 0 ? done() : fail(new Error(`Native provisioning exited ${code}; no fallback`)));
  });
}
const installer = join(directory, filename);
const checksumResponse = await fetch(url + '.sha256', { signal: AbortSignal.timeout(30_000) });
if (!checksumResponse.ok) throw new Error('Cannot obtain the official pinned installer checksum');
const expected = (await checksumResponse.text()).split(/\s+/)[0];
if (!/^[a-f0-9]{64}$/i.test(expected)) throw new Error('Invalid installer checksum');
if (!await stat(installer).catch(() => null)) await download(url, installer);
if (await hash(installer) !== expected.toLowerCase()) throw new Error('Installer checksum mismatch');
const python = process.platform === 'win32' ? join(prefix, 'python.exe') : join(prefix, 'bin/python');
if (!await stat(python).catch(() => null)) {
  if (process.platform === 'win32') {
    if (directory.includes(' ')) throw new Error('NSIS silent /D needs an explicit space-free tool parent; no automatic path change');
    await run(installer, ['/S', '/InstallationType=JustMe', '/RegisterPython=0', '/AddToPath=0', '/NoShortcuts=1', `/D=${prefix}`]);
  } else await run('/bin/bash', [installer, '-b', '-p', prefix]);
}
await run(python, ['-I', '-c', "import sys; assert sys.version_info[:2]==(3,12), sys.version; print(sys.version)"]);
const torchIndex = { cpu: process.platform === 'darwin' ? 'https://pypi.org/simple' : 'https://download.pytorch.org/whl/cpu', cuda: 'https://download.pytorch.org/whl/cu128', mps: 'https://pypi.org/simple', rocm: 'https://download.pytorch.org/whl/rocm6.4' }[backend];
await run(python, ['-I', '-m', 'pip', '--isolated', 'download', '--only-binary=:all:', '--dest', wheels, '--index-url', torchIndex, 'torch==2.8.0']);
await run(python, ['-I', '-m', 'pip', '--isolated', 'download', '--only-binary=:all:', '--dest', wheels, '--index-url', 'https://pypi.org/simple', 'numpy==2.3.1']);
const artifacts = [];
for (const name of (await readdir(wheels)).sort()) {
  if (!name.endsWith('.whl')) throw new Error(`Unexpected wheelhouse file: ${name}`);
  const path = join(wheels, name); artifacts.push({ name, sha256: await hash(path), bytes: (await stat(path)).size });
}
const manifest = { ...identity, installerSha256: expected.toLowerCase(), python, conda: process.platform === 'win32' ? join(prefix, 'Scripts/conda.exe') : join(prefix, 'bin/conda'), wheels, artifacts };
await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ directory, platform: process.platform, backend, artifacts: artifacts.length, bytes: artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0) }));
