// Real pinned Pi + native launcher/Bash/Python, deterministic localhost model.
// No provider credentials, network packages, VM or fixture engine.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat, copyFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, delimiter } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';

const root = resolve('.');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const delay = (ms: number) => new Promise(done => setTimeout(done, ms));
const code = (value: string) => `import json,sys,os\nVALUE=${JSON.stringify(value)}\ndef main():\n print(json.dumps({'value':VALUE,'cwd':os.getcwd(),'prefix':sys.prefix,'python':sys.executable}))\n`;
async function fileHash(path: string): Promise<string> {
  const digest = createHash('sha256'); for await (const chunk of createReadStream(path)) digest.update(chunk); return digest.digest('hex');
}
async function bytes(path: string): Promise<number> {
  let total = 0;
  const entries = await readdir(path, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const entry of entries) {
    if (entry.isDirectory()) total += await bytes(join(path, entry.name));
    else if (entry.isFile()) total += (await stat(join(path, entry.name))).size;
  }
  return total;
}
const backendCode = `import pathlib,zipfile\ndef get_requires_for_build_editable(config_settings=None): return []\ndef build_editable(wheel_directory,config_settings=None,metadata_directory=None):\n name='native_contract-1.0-py3-none-any.whl'\n files={'native_contract.pth':str(pathlib.Path.cwd())+'\\n','native_contract-1.0.dist-info/METADATA':'Metadata-Version: 2.1\\nName: native-contract\\nVersion: 1.0\\n','native_contract-1.0.dist-info/WHEEL':'Wheel-Version: 1.0\\nGenerator: native-contract\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n','native_contract-1.0.dist-info/entry_points.txt':'[console_scripts]\\nenvcheck = ml_probe:main\\n'}\n files['native_contract-1.0.dist-info/RECORD']=''.join(k+',,\\n' for k in files)+'native_contract-1.0.dist-info/RECORD,,\\n'\n with zipfile.ZipFile(pathlib.Path(wheel_directory)/name,'w') as wheel:\n  for k,v in files.items(): wheel.writestr(k,v)\n return name\n`;

function nativePython(ml?: any) {
  if (ml) return ml.python;
  for (const executable of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    try { return execFileSync(executable, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim(); } catch {}
  }
  throw new Error('A native Python with venv/ensurepip is required; no installation fallback');
}

function nativeShell() {
  if (process.platform !== 'win32') return '/bin/bash';
  const git = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  return join(resolve(git, '../../..'), 'bin/bash.exe');
}

test('native managed environment: install once, real Pi tools, editable/launchers, current follow-up, result startup and drain', { timeout: 1800000 }, async t => {
  const started = Date.now();
  const mlManifestPath = process.env.GRAPHER_ENV_TEST_ML_MANIFEST;
  const ml = mlManifestPath ? JSON.parse(await readFile(mlManifestPath, 'utf8')) : undefined;
  const condaManifestPath = process.env.GRAPHER_ENV_TEST_CONDA_MANIFEST;
  assert.ok(!(mlManifestPath && condaManifestPath), 'Do not mix lazy Conda and legacy ML profiles');
  const conda = condaManifestPath ? JSON.parse(await readFile(condaManifestPath, 'utf8')) : undefined;
  const condaPackages: string[] = [];
  if (conda) {
    const toolRoot = resolve(dirname(condaManifestPath!));
    assert.equal(process.platform, 'win32', 'This offline staging profile has Windows packages only');
    assert.equal(conda.platform, process.platform); assert.equal(conda.arch, process.arch);
    assert.equal(resolve(conda.conda), resolve(toolRoot, 'miniforge/Scripts/conda.exe'));
    for (const name of await readdir(join(toolRoot, 'conda-env/conda-meta'))) {
      if (!name.endsWith('.json') || name.startsWith('setuptools-')) continue;
      // This backend needs only native Python/pip, not Conda setuptools' long
      // packaged test-data paths. No archive bytes are modified or repaired.
      const metadata = JSON.parse(await readFile(join(toolRoot, 'conda-env/conda-meta', name), 'utf8'));
      assert.match(metadata.fn, /^[a-zA-Z0-9_.-]+\.(?:conda|tar\.bz2)$/);
      assert.match(metadata.sha256, /^[0-9a-f]{64}$/);
      const archive = join(toolRoot, 'miniforge/pkgs', metadata.fn);
      assert.equal(await fileHash(archive), metadata.sha256, `unverified offline Conda package ${metadata.fn}`);
      condaPackages.push(archive.replaceAll('\\', '/'));
    }
    assert.ok(condaPackages.length > 0);
  }
  if (ml) {
    const toolRoot = resolve(dirname(mlManifestPath!));
    assert.equal(resolve(ml.python), resolve(toolRoot, 'miniforge/python.exe'));
    assert.equal(resolve(ml.conda), resolve(toolRoot, 'miniforge/Scripts/conda.exe'));
    assert.equal(resolve(ml.wheels), resolve(toolRoot, 'wheels'));
    assert.equal(ml.platform, process.platform); assert.equal(ml.arch, process.arch); assert.equal(ml.backend, 'cuda');
    assert.equal(ml.torch, '2.8.0'); assert.equal(ml.numpy, '2.3.1');
    for (const artifact of ml.artifacts) {
      assert.match(artifact.name, /^[a-zA-Z0-9_.+!-]+\.whl$/);
      assert.equal(dirname(resolve(join(ml.wheels, artifact.name))), resolve(ml.wheels));
      assert.equal(await fileHash(join(ml.wheels, artifact.name)), artifact.sha256, `unverified offline wheel ${artifact.name}`);
    }
  }
  // Windows package installers may still require a short physical parent when
  // the host has not enabled long paths. This is test setup, not a Runtime fallback.
  const parent = process.env.GRAPHER_ENV_TEST_PARENT || tmpdir();
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'ge-中 space-'));
  const source = join(directory, 'source 中文 space');
  // Explicitly short disposable ML test layout: Conda's packaged test data can
  // exceed MAX_PATH even when the ordinary venv fixture fits. No Runtime path
  // rewrite, registry change, node-slot change or failed-layout repair is used.
  const workspaceParent = ml || conda ? await mkdtemp(join(parent, 'w中 -')) : join(directory, 'workspaces');
  const data = join(directory, 'data'); const agent = join(directory, 'agent');
  const shell = nativeShell(); const python = nativePython(ml);
  let cudaDevice: { backend: 'cuda'; ids: string[]; probe: string } | undefined;
  let cudaDeviceName: string | undefined;
  if (ml) {
    const probe = execFileSync('where.exe', ['nvidia-smi.exe'], { encoding: 'utf8' }).split(/\r?\n/).find(value => value.trim())?.trim();
    assert.ok(probe && resolve(probe).toLowerCase().startsWith(resolve(process.env.SystemRoot || 'C:/Windows').toLowerCase()), `expected trusted host nvidia-smi under SystemRoot, got ${probe}`);
    const listing = execFileSync(probe, ['--query-gpu=uuid,name,driver_version', '--format=csv,noheader'], { encoding: 'utf8' });
    const rows = listing.trim().split(/\r?\n/).map(line => line.split(',').map(value => value.trim()));
    const selected = process.env.GRAPHER_ENV_TEST_CUDA_DEVICE_NAME;
    const match = rows.find(row => selected ? row[1] === selected : /^GPU-[a-f0-9-]{36}$/i.test(row[0]));
    assert.ok(match && /^GPU-[a-f0-9-]{36}$/i.test(match[0]), `native CUDA device UUID missing: ${listing}`);
    cudaDeviceName = match[1];
    cudaDevice = { backend: 'cuda', ids: [match[0]], probe };
  }
  let backend: ChildProcess | undefined; let diagnostics = ''; let modelCalls = 0;
  const failures: unknown[] = [];
  const commands: string[] = [];
  const modelServer = createServer(async (request, response) => {
    try {
      modelCalls++;
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); const messages = body.messages;
      const lastUser = messages.findLastIndex((m: any) => m.role === 'user');
      const prompt = JSON.stringify(messages[lastUser].content);
      const tools = messages.slice(lastUser + 1).filter((m: any) => m.role === 'tool');
      for (const result of tools) {
        const output = JSON.stringify(result.content);
        assert.doesNotMatch(output, /Native environment observation refused|Traceback|command not found|No such file or directory|AssertionError|exited with code [1-9]/i, `native tool failed: ${output.slice(-12000)}`);
      }
      const step = tools.length;
      let tool: { name: string; arguments: any } | undefined;
      if (step === 0) {
        let command: string;
        const activate = ml ? '' : conda ? 'eval "$(conda shell.bash hook)" && conda activate "$PWD/.venv" && ' : `source '${process.platform === 'win32' ? '.venv/Scripts/activate' : '.venv/bin/activate'}' && `;
        const create = ml ? '' : conda ? `eval "$(conda shell.bash hook)" && conda create --prefix .venv --offline --yes --copy ${condaPackages.map(quote).join(' ')} && ` : 'python -m venv .venv && ';
        if (prompt.includes('RETRY_BACKGROUND') || prompt.includes('B_AFTER_RETRY')) command = 'python -c ' + quote("import pathlib; assert pathlib.Path('.venv/background-partial').read_text()=='partial'; print('RETRY_KEPT_CREATED_ENV')");
        else if (prompt.includes('NO_ENVIRONMENT')) command = 'node -e ' + quote("require('node:fs').writeFileSync('.env','ORDINARY=1'); require('node:fs').writeFileSync('environment.yml','name: declaration-only\\n'); console.log('NO_ENVIRONMENT_NEEDED')");
        else if (prompt.includes('BACKGROUND_WRITER')) command = create + activate + 'python -c ' + quote("import subprocess,sys; subprocess.Popen([sys.executable,'-c',\"import pathlib,time; pathlib.Path('.venv/background-partial').write_text('partial'); time.sleep(90)\"],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); print('BACKGROUND_STARTED')");
        else if (prompt.includes('A_CREATE')) command = create + activate + 'python -m pip install --no-index --no-build-isolation -e . && pip --version && python -c ' + quote("import sys,pathlib,os; assert sys.prefix == str(pathlib.Path.cwd()/'.venv'); assert not os.environ.get('PYTHONHOME'); assert 'outer-poison' not in os.environ.get('PATH',''); print(sys.executable)");
        else if (prompt.includes('B_USE')) command = 'envcheck && python -c ' + quote("import sysconfig,pathlib; pathlib.Path(sysconfig.get_paths()['purelib'],'native_dependency.py').write_text('VERSION=2\\n')");
        else if (prompt.includes('C_USE')) command = 'envcheck && python -c ' + quote("import native_dependency,pathlib,json,sys; assert native_dependency.VERSION==2; pathlib.Path('reports').mkdir(exist_ok=True); pathlib.Path('reports/C.json').write_text(json.dumps({'version':2,'prefix':sys.prefix}))");
        else if (prompt.includes('FOLLOWUP_2')) command = 'envcheck && python -c ' + quote("import native_dependency,pathlib; assert native_dependency.VERSION==3; assert pathlib.Path('reports/C.json').exists(); print('CURRENT_VIEW_RESTORED')");
        else if (prompt.includes('FOLLOWUP_A')) command = 'envcheck && python -c ' + quote("import native_dependency,ml_probe,sysconfig,pathlib; assert native_dependency.VERSION==2; assert ml_probe.VALUE=='C'; assert pathlib.Path('reports/C.json').exists(); pathlib.Path(sysconfig.get_paths()['purelib'],'native_dependency.py').write_text('VERSION=3\\n')");
        else throw new Error(`Unexpected prompt ${prompt}`);
        commands.push(command); tool = { name: 'bash', arguments: { command } };
      } else if (step === 1 && /A_CREATE|B_USE|C_USE/.test(prompt)) {
        const value = prompt.includes('C_USE') ? 'C' : prompt.includes('B_USE') ? 'B' : 'A';
        tool = { name: 'write', arguments: { path: join(source, 'ml_probe.py'), content: code(value) } };
      } else if (step === 2 && /A_CREATE|B_USE|C_USE/.test(prompt)) {
        const activate = !ml && prompt.includes('A_CREATE') ? conda ? 'eval "$(conda shell.bash hook)" && conda activate "$PWD/.venv" && ' : `source '${process.platform === 'win32' ? '.venv/Scripts/activate' : '.venv/bin/activate'}' && ` : '';
        tool = { name: 'bash', arguments: { command: activate + 'envcheck && python -c ' + quote("import ml_probe; ml_probe.main()") } };
      } else if (step === 3 && prompt.includes('C_USE')) {
        tool = { name: 'read', arguments: { path: join(source, 'reports/C.json') } };
      }
      const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `env-${modelCalls}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { role: 'assistant', content: 'Completed native environment contract' };
      const chunk = (delta: any, reason: string | null) => ({ id: 'env', object: 'chat.completion.chunk', created: 1, model: 'native', choices: [{ index: 0, delta, finish_reason: reason }] });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, tool ? 'tool_calls' : 'stop'))}\n\ndata: [DONE]\n\n`);
    } catch (error) { failures.push(error); response.writeHead(500); response.end(String(error)); }
  });
  const stop = async () => {
    if (backend?.pid && backend.exitCode === null && backend.signalCode === null) {
      const exited = once(backend, 'exit'); backend.kill('SIGKILL'); await exited;
    }
  };
  try {
    await mkdir(source); await mkdir(agent);
    await writeFile(join(source, '.gitignore'), '.venv/\n.agent-home/\n.runtime-cache/\nreports/\n');
    await writeFile(join(source, 'ml_probe.py'), code('source'));
    await writeFile(join(source, 'editable_backend.py'), backendCode);
    await writeFile(join(source, 'pyproject.toml'), '[build-system]\nrequires=[]\nbuild-backend="editable_backend"\nbackend-path=["."]\n');
    await mkdir(join(source, '.pi/extensions'), { recursive: true });
    await writeFile(join(source, '.pi/extensions/launch-probe.ts'), `import {execFileSync} from 'node:child_process'; import {writeFileSync} from 'node:fs'; export default function(){ const proof=execFileSync('python',['-c','import sys,json,os; print(json.dumps({"prefix":sys.prefix,"cwd":os.getcwd()}))'],{encoding:'utf8'}); writeFileSync('.runtime-cache/extension.json',proof); }`);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@localhost', ...args], { cwd: source, encoding: 'utf8' }).trim();
    git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'baseline');
    await new Promise<void>(done => modelServer.listen(0, '127.0.0.1', done));
    await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { 'environment-test': {
      baseUrl: `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`, api: 'openai-completions', apiKey: 'local-only',
      models: [{ id: 'native', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    const listener = createServer(); await new Promise<void>(done => listener.listen(0, '127.0.0.1', done));
    const port = (listener.address() as AddressInfo).port; await new Promise<void>(done => listener.close(() => done()));
    const target = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(root, 'backend/target');
    const env = { ...process.env, GRAPHER_DATA_DIR: data, GRAPHER_PORT: String(port), PI_CODING_AGENT_DIR: agent,
      GRAPHER_ISOLATED_PI_MODELS: '1', GRAPHER_NATIVE_RUNTIME_PARENT: join(directory, 'engine-cache'), GRAPHER_WORKSPACE_PARENT: workspaceParent,
      GRAPHER_GLOBAL_PI_AGENT_DIR: join(directory, 'global-agent'), NODE_AGENT_MODEL: 'environment-test/native', NODE_AGENT_THINKING: 'off',
      VIRTUAL_ENV: 'outer-poison', CONDA_PREFIX: 'outer-poison', PYTHONPATH: 'outer-poison', PYTHONHOME: 'outer-poison', BASH_ENV: 'outer-poison',
      LOCALAPPDATA: join(directory, 'local-app-data'), USERPROFILE: join(directory, 'profile'),
      ...(conda ? { PATH: [dirname(conda.conda), process.env.PATH].join(delimiter) } : {}) };
    const profile = ml ? 'release' : 'debug';
    const built = join(target, profile, process.platform === 'win32' ? 'grapher.exe' : 'grapher');
    const executable = join(directory, process.platform === 'win32' ? 'grapher.exe' : 'grapher');
    await copyFile(built, executable);
    if (process.platform !== 'win32') await chmod(executable, (await stat(built)).mode & 0o777);
    backend = spawn(executable, [], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    backend.stderr!.on('data', chunk => { diagnostics += chunk.toString(); });
    const api = async (command: string, body: any = {}, timeout = 120000) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/${command}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.any([t.signal, AbortSignal.timeout(timeout)]) });
      const payload = await response.json() as any;
      if (!response.ok || payload.error) throw new Error(payload.error || response.status);
      return payload.result;
    };
    const stage = (label: string) => { if (ml) console.error(JSON.stringify({ stage: label, elapsedMs: Date.now() - started, modelCalls })); };
    const until = async (check: () => Promise<any>, label: string) => {
      const start = Date.now();
      while (Date.now() - start < (ml ? 1_200_000 : 180_000)) {
        t.signal.throwIfAborted(); assert.deepEqual(failures, []);
        if (backend!.exitCode !== null || backend!.signalCode !== null) throw new Error(diagnostics);
        const result = await check(); if (result) return result; await delay(100);
      }
      throw new Error(`${label}\n${diagnostics}`);
    };
    await until(async () => { try { return await api('bootstrap', {}, 5000); } catch { return false; } }, 'backend startup');
    const windows = process.platform === 'win32';
    const capabilities = await api('environment_capabilities');
    let initialize: string[] = [python, '-m', 'venv', '{workspace}/.venv'];
    let hook: string | null = null;
    if (ml) {
      const condaPath = ml.conda.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
      const pkgs = join(dirname(dirname(ml.conda)), 'pkgs');
      const script = `const {spawnSync}=require('node:child_process'); const path=require('node:path'); const [conda,wheels,workspace,packages]=process.argv.slice(1); const prefix=path.join(workspace,'.venv'); const env={...process.env,CONDA_PKGS_DIRS:packages}; for(const key of ['CONDA_PREFIX','CONDA_DEFAULT_ENV','CONDA_SHLVL','CONDA_PROMPT_MODIFIER']) delete env[key]; for(const [exe,args] of [[conda,['create','--prefix',prefix,'--offline','--yes','--copy','python=3.12.11']],[path.join(prefix,'python.exe'),['-I','-m','pip','--isolated','install','--no-index','--find-links',wheels,'torch==2.8.0+cu128','numpy==2.3.1']]]) {const out=spawnSync(exe,args,{stdio:'inherit',env,maxBuffer:8*1024*1024}); if(out.error){console.error(out.error);process.exit(1)} if(out.status!==0)process.exit(out.status||1)}`;
      initialize = [process.execPath, '-e', script, ml.conda, ml.wheels, '{workspace}', pkgs];
      hook = `eval "$('${condaPath}' shell.bash hook)" && conda activate '{workspace}/.venv'`;
    }
    const toolPaths = windows ? [join(dirname(shell), '../usr/bin'), join(dirname(shell), '../mingw64/bin'), dirname(process.execPath), join(process.env.SystemRoot!, 'System32'), ...(ml ? [dirname(ml.conda)] : [])] : [dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'];
    const environment = { mode: 'native-workspace', platform: capabilities.platform, arch: capabilities.arch,
      scopes: ['.venv', '.agent-home'], caches: ['.runtime-cache'], layout: 'fixed',
      baseline: [python, '-I', '-c', "import sys,sysconfig,platform,ssl,zlib,struct,json; print(json.dumps({'version':sys.version,'abi':sysconfig.get_config_var('SOABI'),'platform':sysconfig.get_platform(),'machine':platform.machine(),'bits':struct.calcsize('P')*8,'openssl':ssl.OPENSSL_VERSION,'zlib':zlib.ZLIB_RUNTIME_VERSION},sort_keys=True))"],
      initialize, importSource: false, authority: {}, allowDescendant: false,
      require: [...['basic-snapshots', 'process-drain'], ...(cudaDevice ? ['cuda', 'device-leases'] : [])],
      ...(cudaDevice ? { resources: { device: cudaDevice, initializeTimeoutSeconds: 3600, maxOutputBytes: 64 * 1024 * 1024 } } : {}),
      launch: { entry: windows ? (ml ? '{workspace}/.venv/python.exe' : '{workspace}/.venv/Scripts/python.exe') : '{workspace}/.venv/bin/python',
        path: [windows ? (ml ? '{workspace}/.venv' : '{workspace}/.venv/Scripts') : '{workspace}/.venv/bin', ...(windows && ml ? ['{workspace}/.venv/Scripts', '{workspace}/.venv/Library/bin'] : []), ...toolPaths], shell,
        variables: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', HOME: '{workspace}/.agent-home', USERPROFILE: '{workspace}/.agent-home', VIRTUAL_ENV: '{workspace}/.venv', PYTHONPYCACHEPREFIX: '{workspace}/.runtime-cache/pycache' }, inherit: [], hook } };
    const graph = { originalGoal: 'native ML environment contract', nodes: [{ name: 'A', task: 'A_CREATE' }, { name: 'B', task: 'B_USE' }, { name: 'C', task: 'C_USE' }],
      edges: [{ from: 'A', to: 'B', feedback: false }, { from: 'B', to: 'C', feedback: false }] };
    // Normal acceptance exercises backend admission with no policy supplied by
    // the client. The ML profile additionally covers the saved-policy boundary;
    // automatic Conda/device policy discovery remains separately unaccepted.
    const config = { repository: source, model: 'environment-test/native', thinkingLevel: 'off', maxParallel: 4, maxFeedback: 1, ...(ml ? { environment } : {}) };
    const saved = await api('save_graph', { graph, config });
    if (!ml) assert.equal(saved.environmentPolicy, 'automatic-pending');
    const runId = saved.runId;
    const progress = ml ? setInterval(() => {
      void Promise.all(['records', 'files/blobs', 'proofs'].map(name => readdir(join(data, 'environments', runId, name)).catch(() => [])))
        .then(([records, blobs, proofs]) => console.error(JSON.stringify({ stage: 'progress', elapsedMs: Date.now() - started, modelCalls, records, blobs: blobs.length, proofs: proofs.length })));
    }, 30_000) : undefined;
    if (progress) { progress.unref(); t.after(() => clearInterval(progress)); }
    await api('control', { runId, action: 'approve' }); stage('approved');
    const settled = () => until(async () => {
      const state = await api('snapshot', { runId, detail: 'metadata' });
      if (['needs_attention', 'publication_failed', 'paused'].includes(state.phase)) throw new Error(JSON.stringify(state.nodes) + '\n' + diagnostics);
      return state.phase === 'completed' && state;
    }, 'native environment execution');
    const initial = await settled(); stage('initial-completed');
    const initialWallMs = Date.now() - started;
    assert.equal(initial.executions.length, 3);
    if (!ml) {
      assert.equal(initial.environmentPolicy, 'automatic-lazy');
      assert.deepEqual(initial.config.environment.initialize, []);
      assert.equal(initial.config.environment.discovery, true);
      assert.deepEqual(initial.config.environment.authority, {});
      assert.equal(initial.config.environment.allowDescendant, true);
      assert.equal(initial.config.environment.layout, 'fixed');
      assert.equal(initial.config.environment.importSource, false);
    }
    const workspace = initial.executions[0].worktree;
    if (!ml) {
      const launch = (ref: string) => readFile(join(data, 'environments', runId, 'launches', `${ref}.json`), 'utf8').then(JSON.parse);
      assert.equal((await launch(initial.executions[0].input.launchRef)).environment, undefined, 'A starts empty');
      assert.equal((await launch(initial.executions[0].result.launchRef)).environment.kind, conda ? 'conda' : 'venv');
    }
    assert.ok(initial.executions.every((execution: any) => execution.worktree === workspace));
    assert.equal(initial.executions[1].result.environmentRef, initial.executions[2].result.environmentRef, 'declared pycache does not fork E');
    assert.equal(commands.filter(command => command.includes('pip install')).length, 1);
    assert.equal((await readFile(join(source, 'ml_probe.py'), 'utf8')).replaceAll('\r\n', '\n'), code('C'));
    assert.equal(JSON.parse(await readFile(join(source, 'reports/C.json'), 'utf8')).version, 2);
    await assert.rejects(readFile(join(source, '.venv/pyvenv.cfg')), /ENOENT/);
    const proof = JSON.parse(await readFile(join(workspace, '.runtime-cache/extension.json'), 'utf8'));
    assert.equal(proof.cwd, workspace); assert.equal(proof.prefix, join(workspace, '.venv'));
    if (ml) {
      for (const execution of initial.executions) {
        const proof = JSON.parse(await readFile(join(data, 'environments', runId, 'proofs', execution.result.generation, 'accelerator.json'), 'utf8'));
        assert.equal(proof.backend, 'cuda'); assert.equal(proof.runtime, '12.8');
        assert.equal(proof.framework, '2.8.0+cu128');
        assert.deepEqual(proof.devices.map((device: any) => device.id), cudaDevice!.ids);
        assert.equal(proof.devices[0].sum, 357389824);
      }
    }
    const old = initial.executions.map((execution: any) => execution.result);
    await api('control', { runId, action: 'intervene', node: 'A', instruction: 'FOLLOWUP_A' });
    const followup = await settled();
    const last = followup.executions.at(-1);
    assert.equal(last.worktree, workspace); assert.equal(last.sessionId, initial.executions[0].sessionId);
    assert.equal(last.input.environmentRef, old[2].environmentRef);
    assert.equal(last.before, last.after, 'environment-only follow-up leaves Git head unchanged');
    for (const name of ['A', 'B', 'C']) { assert.equal(followup.nodes[name].status, 'done'); assert.deepEqual(followup.nodes[name].result, last.result); }
    for (let i = 0; i < 3; i++) assert.deepEqual(followup.executions[i].result, old[i]);
    const callsBeforeResult = modelCalls;
    const resultArgs = ml ? ['-c', "import json,torch; assert torch.cuda.is_available() and torch.version.cuda and torch.version.hip is None; x=torch.arange(4096,device='cuda',dtype=torch.float32); w=torch.tensor(0.25,device='cuda',requires_grad=True); loss=(x*w).sin().mean(); loss.backward(); torch.cuda.synchronize(); assert w.grad is not None; print(json.dumps({'device':torch.cuda.get_device_name(0),'cuda':torch.version.cuda,'loss':loss.item(),'gradient':w.grad.item()}))"]
      : ['-c', "import native_dependency,ml_probe; assert native_dependency.VERSION==3; ml_probe.main()"];
    stage('result-launch-start');
    const launched = await api('launch_result', { runId, args: resultArgs }, ml ? 1_200_000 : 120_000); stage('result-launch-done');
    if (ml) assert.match(launched.output, new RegExp(`\\\"device\\\": \\\"${cudaDeviceName}\\\"`));
    else assert.match(launched.output, /\"value\": \"C\"/);
    assert.equal(modelCalls, callsBeforeResult); await settled();
    // Rebuild the CURRENT terminal composite result at its fixed native path.
    const restoreStarted = Date.now();
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await api('control', { runId, action: 'intervene', node: 'A', instruction: 'FOLLOWUP_2' });
    const rebuilt = await settled(); assert.equal(rebuilt.executions.at(-1).worktree, workspace);
    const restoredFollowupWallMs = Date.now() - restoreStarted;
    const workingEnvironmentBytes = await bytes(join(workspace, '.venv')) + await bytes(join(workspace, '.agent-home'));
    const retainedEnvironmentBytes = await bytes(join(data, 'environments', runId));
    const stateBeforeCancel = rebuilt.nodes.C.result;
    const cancelDelay = ml ? 121_000 : 0;
    const pending = api('launch_result', { runId, args: ['-c', `import pathlib,time; pathlib.Path('reports/result-started').write_text('partial'); time.sleep(${ml ? 125 : 90})`] }, 600000);
    // Attach the rejection immediately; cancellation is expected, not unhandled.
    const cancelled = assert.rejects(pending, /failed|drain|timed out|cancelled/i);
    await until(async () => { try { return await readFile(join(workspace, 'reports/result-started'), 'utf8'); } catch { return false; } }, 'result process start');
    let metadataLatencyMs: number | undefined;
    if (cancelDelay) {
      await delay(cancelDelay);
      const metadataStarted = Date.now();
      const responsive = await api('snapshot', { runId, detail: 'metadata' }, 5000);
      metadataLatencyMs = Date.now() - metadataStarted;
      assert.equal(responsive.resultExecution.status, 'running', 'results exceeding 120 seconds remain active/cancellable');
    }
    await api('cancel_result', { runId }); await cancelled;
    const failed = await api('snapshot', { runId }); assert.equal(failed.resultExecution.status, 'failed');
    assert.deepEqual(failed.nodes.C.result, stateBeforeCancel);
    const retry = await api('launch_result', { runId, args: ['-c', "import pathlib; assert pathlib.Path('reports/result-started').read_text()=='partial'; print('RETRY_KEPT_PARTIAL')"] });
    assert.match(retry.output, /RETRY_KEPT_PARTIAL/); await settled();
    const background = await api('save_graph', { graph: { originalGoal: 'native drain boundary', nodes: [{ name: 'writer', task: 'BACKGROUND_WRITER' }, { name: 'downstream', task: 'B_AFTER_RETRY' }], edges: [{ from: 'writer', to: 'downstream', feedback: false }] },
      config });
    await api('control', { runId: background.runId, action: 'approve' });
    const blocked = await until(async () => { const state = await api('snapshot', { runId: background.runId }); return state.phase === 'needs_attention' && state; }, 'background drain failure');
    assert.match(blocked.nodes.writer.error, /background writers have not drained/i);
    assert.equal(blocked.executions.length, 1); assert.equal(blocked.nodes.downstream.status, 'blocked');
    assert.equal(blocked.executions[0].result, undefined); assert.ok(blocked.executions[0].input);
    assert.equal(await readFile(join(blocked.executions[0].worktree, '.venv/background-partial'), 'utf8'), 'partial');
    await api('control', { runId: background.runId, action: 'intervene', node: 'writer', instruction: 'RETRY_BACKGROUND' });
    const repaired = await until(async () => {
      const state = await api('snapshot', { runId: background.runId });
      if (state.executions.length > 1 && state.executions.at(-1).status === 'failed') throw new Error(JSON.stringify(state.nodes) + '\n' + diagnostics);
      return state.nodes.writer.status === 'done' && state;
    }, 'retry discovery of the created failed-partial environment');
    assert.equal(repaired.executions.length, 2);
    assert.equal(repaired.nodes.downstream.status, 'blocked', 'Environment recovery does not invent business completion');
    assert.deepEqual(repaired.executions[0].input, blocked.executions[0].input, 'Failed input evidence stays immutable');
    assert.equal(repaired.executions[1].worktree, blocked.executions[0].worktree);
    assert.equal(repaired.executions[1].status, 'completed');
    if (!ml) {
      const launch = JSON.parse(await readFile(join(data, 'environments', background.runId, 'launches', `${repaired.executions[1].result.launchRef}.json`), 'utf8'));
      assert.equal(launch.environment.kind, conda ? 'conda' : 'venv');
    }
    if (!ml) {
      const plain = join(directory, 'plain project'); await mkdir(plain);
      execFileSync('git', ['init', '-q'], { cwd: plain });
      await writeFile(join(plain, 'README.md'), 'An ordinary project without a business environment.\n');
      execFileSync('git', ['add', 'README.md'], { cwd: plain });
      execFileSync('git', ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'plain baseline'], { cwd: plain });
      const empty = await api('save_graph', { graph: { originalGoal: 'No environment needed', nodes: [{ name: 'plain', task: 'NO_ENVIRONMENT' }], edges: [] }, config: { ...config, repository: plain } });
      await api('control', { runId: empty.runId, action: 'approve' });
      const done = await until(async () => {
        const state = await api('snapshot', { runId: empty.runId });
        if (['needs_attention', 'publication_failed'].includes(state.phase)) throw new Error(JSON.stringify(state.nodes));
        return state.phase === 'completed' && state;
      }, 'plain project without an environment');
      const input = done.executions[0].input; const result = done.executions[0].result;
      assert.equal(result.launchRef, input.launchRef, 'Declarations and .env do not change L');
      const launch = JSON.parse(await readFile(join(data, 'environments', empty.runId, 'launches', `${result.launchRef}.json`), 'utf8'));
      assert.equal(launch.environment, undefined);
      await assert.rejects(stat(join(done.executions[0].worktree, '.venv')), /ENOENT/);
      const calls = modelCalls;
      const executed = await api('launch_result', { runId: empty.runId, args: ['-c', 'node -p ' + quote('"EMPTY_NATIVE_RESULT"')] });
      assert.match(executed.output, /EMPTY_NATIVE_RESULT/); assert.equal(modelCalls, calls);
    }
    console.log(JSON.stringify({ platform: process.platform, arch: process.arch, profile, python, shell, binding: conda ? 'lazy-conda' : ml ? 'legacy-conda-cuda' : 'lazy-venv', modelCalls, installCount: 1, cwd: workspace,
      accelerator: cudaDevice ? { backend: 'cuda', device: cudaDeviceName, ids: cudaDevice.ids, framework: '2.8.0+cu128', runtime: '12.8', locked: true, forwardBackward: true, exceeds120s: true, metadataLatencyMs } : 'not-tested',
      initialWallMs, restoredFollowupWallMs, workingEnvironmentBytes, retainedEnvironmentBytes, elapsedMs: Date.now() - started }));
  } catch (error) { throw new Error(`${error}\nNative acceptance elapsed=${Date.now() - started}ms; modelCalls=${modelCalls}; completed tool requests=${commands.length}\n${diagnostics}`); }
  finally {
    await stop(); await new Promise<void>(done => modelServer.close(() => done()));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    if (ml) await rm(workspaceParent, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
