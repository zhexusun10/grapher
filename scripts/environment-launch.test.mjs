import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { dirname, join, resolve, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { managedBashCommand } from '../engine/launch-binding.mjs';

const shell = process.platform === 'win32'
  ? join(resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../..'), 'bin/bash.exe') : '/bin/bash';
const module = pathToFileURL(resolve('engine/launch-binding.mjs')).href;
const base = () => ({ entry: process.execPath, path: [dirname(process.execPath)], shell, variables: { LAUNCH_TEST: 'configured' }, inherit: [], hook: null });
const run = (launch, code, extra = {}, cwd = undefined) => {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-launch-'));
  try {
    const binding = join(directory, 'launch.json'); writeFileSync(binding, JSON.stringify(launch));
    return spawnSync(process.execPath, ['--input-type=module', '-e', `import {applyLaunchBinding,managedBashOptions,managedBashCommand,managedBusinessEnvironment} from ${JSON.stringify(module)}; import {execFileSync} from 'node:child_process'; applyLaunchBinding(); ${code}`], {
      cwd, encoding: 'utf8', env: { ...process.env, GRAPHER_LAUNCH_BINDING: binding, GRAPHER_MODE: 'node', ...extra }, timeout: 15000,
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
};

test('declared hook runs before factories and cannot change Pi/Runtime identity or Shell bootstrap', () => {
  const launch = base();
  launch.hook = 'export LAUNCH_TEST=hook; export CONDA_PREFIX="declared-prefix"; export GRAPHER_MODE=other; export NODE_OPTIONS=poison; export BASH_ENV=poison';
  const result = run(launch, "console.log(JSON.stringify({value:process.env.LAUNCH_TEST,prefix:process.env.CONDA_PREFIX,role:process.env.GRAPHER_MODE,options:process.env.NODE_OPTIONS,bash:process.env.BASH_ENV}))");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { value: 'hook', prefix: 'declared-prefix', role: 'node' });
});

test('Pi PATH preprocessing cannot change an explicit managed Bash PATH and shell controls are preserved', () => {
  const result = run(base(), "console.log(JSON.stringify(managedBashOptions({env:{PATH:'old',Path:'old-too',bAsH_EnV:'startup',ENV:'startup-env',SHELLOPTS:'pipefail',BASHOPTS:'nullglob',CDPATH:'project-cd',OLDPWD:'previous-dir',GLOBIGNORE:'*.tmp',PYTHONDONTWRITEBYTECODE:'0',KEEP:'yes'}}).env))");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    bAsH_EnV: 'startup', ENV: 'startup-env', SHELLOPTS: 'pipefail', BASHOPTS: 'nullglob',
    CDPATH: 'project-cd', OLDPWD: 'previous-dir', GLOBIGNORE: '*.tmp',
    PYTHONDONTWRITEBYTECODE: '1', KEEP: 'yes', PATH: dirname(process.execPath),
  });
});

test('automatic unbound Bash preserves business PATH precedence without weakening bound entries', () => {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-business-path-'));
  try {
    const first = join(directory, 'host-first');
    const second = join(directory, 'bootstrap-second');
    for (const [bin, value] of [[first, 'host-first'], [second, 'bootstrap-second']]) {
      mkdirSync(bin);
      writeFileSync(join(bin, 'parity-tool'), `#!/bin/sh\nprintf '%s\\n' '${value}'\n`, { mode: 0o755 });
    }
    const launch = { ...base(), inheritAmbient: true, entry: shell, path: [first, second, dirname(shell)] };
    const result = run(launch, `console.log(execFileSync(${JSON.stringify(shell)},['--noprofile','--norc','-c',managedBashCommand('parity-tool')],{env:managedBashOptions({env:{...process.env}}).env,encoding:'utf8'}).trim())`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'host-first');
    for (const strict of [
      { ...launch, inheritAmbient: false },
      { ...launch, environment: { kind: 'venv', prefix: 'env', abi: '0'.repeat(40) } },
      { ...launch, hook: 'true' },
    ]) {
      const refused = run(strict, "console.log('FACTORY_RAN')");
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /Declared default entry\/PATH/);
      assert.doesNotMatch(refused.stdout, /FACTORY_RAN/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('automatic PATH keeps relative, empty and future entries with native cd semantics', () => {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-relative-path-'));
  try {
    const script = (path, output) => writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, { mode: 0o755 });
    mkdirSync(join(directory, 'bin'));
    mkdirSync(join(directory, 'sub/bin'), { recursive: true });
    script(join(directory, 'bin/choice'), 'root-bin');
    script(join(directory, 'sub/bin/choice'), 'nested-bin');
    script(join(directory, 'cwd-only'), 'cwd-entry');
    const path = ['future', 'bin', '', dirname(shell)];
    const launch = { ...base(), entry: shell, inheritAmbient: true, path, unboundPath: path };
    // Native Bash caches command paths; the business command explicitly clears
    // that cache after cd rather than having the adapter change shell options.
    const code = `process.chdir(${JSON.stringify(directory)}); console.log(execFileSync(${JSON.stringify(shell)},['--noprofile','--norc','-c',managedBashCommand('choice; cwd-only; cd sub; hash -r; choice',process.cwd())],{cwd:process.cwd(),env:managedBashOptions({env:{...process.env}}).env,encoding:'utf8'}).trim())`;
    const result = run(launch, code);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim().replaceAll('\r', ''), 'root-bin\ncwd-entry\nnested-bin');
    mkdirSync(join(directory, 'future'));
    script(join(directory, 'future/choice'), 'future-installed');
    const installed = run(launch, code);
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(installed.stdout.trim().replaceAll('\r', ''), 'future-installed\ncwd-entry\nnested-bin');
    const legacy = run({ ...launch, unboundPath: undefined }, '');
    assert.notEqual(legacy.status, 0, 'old explicit bindings still require absolute PATH entries');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Windows PATH keeps a semicolon directory as one entry through validation and Bash', { skip: process.platform !== 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-path-list-'));
  try {
    const bin = join(directory, 'native;bin');
    mkdirSync(bin);
    const entry = join(bin, 'business-node.exe');
    copyFileSync(process.execPath, entry);
    writeFileSync(join(bin, 'path-choice'), "#!/bin/sh\nprintf 'semicolon-directory\\n'\n", { mode: 0o755 });
    for (const hook of [null, 'export HOOK_VALUE=ready']) {
      const launch = { ...base(), entry, path: [bin, dirname(shell)], hook };
      const result = run(launch, `
const env=managedBashOptions({env:{...process.env}}).env;
const shell=execFileSync(${JSON.stringify(shell)},['--noprofile','--norc','-c',managedBashCommand('path-choice')],{env,encoding:'utf8'}).trim();
const entry=execFileSync(${JSON.stringify(entry)},['-p','6*7'],{env:managedBusinessEnvironment(),encoding:'utf8'}).trim();
console.log(JSON.stringify({shell,entry,path:env.PATH}));`);
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.shell, 'semicolon-directory');
      assert.equal(output.entry, '42');
      assert.equal(output.path, `"${bin}";${dirname(shell)}`);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Windows hook capture preserves changed PATH order, relative entries and new quoted directories', { skip: process.platform !== 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-hook-search-'));
  try {
    const workspace = join(directory, 'workspace');
    const added = join(directory, 'hook;bin');
    const script = (bin, name, value) => {
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' '${value}'\n`, { mode: 0o755 });
    };
    script(join(workspace, 'relative-hook'), 'hook-choice', 'root');
    script(join(workspace, 'sub/relative-hook'), 'hook-choice', 'nested');
    script(join(directory, 'shared-tools'), 'parent-choice', 'outer-parent');
    script(join(workspace, 'shared-tools'), 'parent-choice', 'inner-parent');
    script(added, 'added-choice', 'added');
    const quote = value => `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
    const path = [dirname(process.execPath), '../shared-tools', dirname(shell)];
    const launch = { ...base(), path, unboundPath: path,
      hook: `__extra=$(/usr/bin/cygpath -u -- ${quote(added)}) || exit $?\nexport PATH="$PATH:$__extra:relative-hook::"\nunset __extra` };
    const result = run(launch, `
const env=managedBashOptions({env:{...process.env}}).env;
const shell=execFileSync(${JSON.stringify(shell)},['--noprofile','--norc','-c',managedBashCommand('hook-choice; parent-choice; added-choice; cd sub; hash -r; hook-choice; parent-choice; added-choice',process.cwd())],{cwd:process.cwd(),env,encoding:'utf8'}).trim();
const direct=execFileSync(process.execPath,['-p','process.env.PATH'],{env:managedBusinessEnvironment(),encoding:'utf8'}).trim();
console.log(JSON.stringify({shell,path:env.PATH,direct}));`, {}, workspace);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.shell.replaceAll('\r', ''), 'root\nouter-parent\nadded\nnested\ninner-parent\nadded');
    assert.equal(output.path, `${path.join(';')};"${added}";relative-hook;;`);
    assert.equal(output.direct, output.path);
    // Capturing a hook must not re-add old PATH entries that it removed.
    const removed = run({ ...launch, hook: 'export PATH="${PATH%%:*}"' }, 'console.log(process.env.PATH)', {}, workspace);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(removed.stdout.trim(), path[0]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('bound hooks cannot replace their absolute entry directory with cwd or an absent PATH', () => {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-hook-path-'));
  try {
    const entry = join(directory, 'entry');
    writeFileSync(entry, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    for (const hook of ['unset PATH', 'export PATH=.', 'export PATH=']) {
      const launch = { ...base(), entry, path: [directory], hook };
      const result = run(launch, "console.log('FACTORY_RAN')", {}, directory);
      assert.notEqual(result.status, 0, hook);
      assert.match(result.stderr, /Declared default entry\/PATH/);
      assert.doesNotMatch(result.stdout, /FACTORY_RAN/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('activation hooks restore the workspace after inherited Bash startup changes cwd', () => {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-hook-cwd-'));
  try {
    const workspace = join(directory, 'workspace');
    const elsewhere = join(directory, 'startup-directory');
    mkdirSync(workspace);
    mkdirSync(elsewhere);
    writeFileSync(join(workspace, 'context.txt'), 'workspace');
    writeFileSync(join(elsewhere, 'context.txt'), 'startup');
    const startup = join(directory, 'startup.sh');
    const quote = value => `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
    writeFileSync(startup, `cd ${quote(elsewhere)}\nexport STARTUP_VALUE=retained\n`);
    const launch = { ...base(), hook: 'export HOOK_CONTEXT="$(<context.txt)"' };
    const result = run(launch, "console.log(JSON.stringify({context:process.env.HOOK_CONTEXT,startup:process.env.STARTUP_VALUE}))", { BASH_ENV: startup }, workspace);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { context: 'workspace', startup: 'retained' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('workspace cwd binding does not overwrite OLDPWD when Bash is already in the workspace', () => {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-cwd-oldpwd-'));
  try {
    const workspace = join(directory, 'workspace');
    const previous = join(directory, 'previous');
    mkdirSync(workspace);
    mkdirSync(previous);
    const startup = join(directory, 'startup.sh');
    const quote = value => `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
    writeFileSync(startup, `export OLDPWD=${quote(previous)}\n`);
    const command = 'cd - >/dev/null && pwd -P';
    const unmanaged = managedBashCommand(command, workspace);
    const result = run(base(), `
const execute=command=>execFileSync(${JSON.stringify(shell)},['--noprofile','--norc','-c',command],{cwd:process.cwd(),env:managedBashOptions({env:{...process.env}}).env,encoding:'utf8'}).trim();
console.log(JSON.stringify({native:execute(${JSON.stringify(command)}),unmanaged:execute(${JSON.stringify(unmanaged)}),managed:execute(managedBashCommand(${JSON.stringify(command)},process.cwd()))}));`, { BASH_ENV: startup }, workspace);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.match(output.native.replaceAll('\\', '/'), /\/previous$/);
    assert.equal(output.unmanaged, output.native, 'cwd preamble changed the ordinary cd - command');
    assert.equal(output.managed, output.native, 'managed PATH binding changed the ordinary cd - command');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('cwd aliases and activation capture preserve unset or readonly OLDPWD', () => {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-cwd-alias-'));
  try {
    const workspace = join(directory, 'workspace');
    const alias = join(directory, 'workspace-alias');
    mkdirSync(workspace);
    symlinkSync(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const startup = join(directory, 'startup.sh');
    const command = 'printf "%s" "${OLDPWD-unset}"';
    for (const [setup, expected] of [['unset OLDPWD', 'unset'], ['export OLDPWD=business-previous; readonly OLDPWD', 'business-previous']]) {
      writeFileSync(startup, `${setup}\n`);
      const launch = { ...base(), hook: 'export HOOK_OLDPWD="${OLDPWD-unset}"' };
      const result = run(launch, `
const child=execFileSync(${JSON.stringify(shell)},['--noprofile','--norc','-c',managedBashCommand(${JSON.stringify(command)},${JSON.stringify(alias)})],{cwd:process.cwd(),env:managedBashOptions({env:{...process.env}}).env,encoding:'utf8'});
console.log(JSON.stringify({hook:process.env.HOOK_OLDPWD,child}));`, { BASH_ENV: startup }, workspace);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { hook: expected, child: expected });
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('business Node options and module paths reach children but not engine factories or hook capture', () => {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-business-node-'));
  try {
    const preload = join(directory, 'preload.cjs');
    writeFileSync(preload, "globalThis.businessPreload='loaded';\n");
    const modules = join(directory, 'modules');
    mkdirSync(join(modules, 'business-only'), { recursive: true });
    writeFileSync(join(modules, 'business-only/index.js'), 'module.exports=42;\n');
    const values = {
      NODE_OPTIONS: `--stack-trace-limit=29 --require ${JSON.stringify(preload.replaceAll('\\', '/'))}`,
      NODE_PATH: modules,
    };
    const launch = { ...base(), hook: 'export NODE_OPTIONS=invalid-hook-option; export NODE_PATH=invalid-hook-modules' };
    const result = run(launch, `
if(process.env.NODE_OPTIONS || process.env.NODE_PATH || globalThis.businessPreload) throw Error('Business Node setup reached factories');
if(process.env.GRAPHER_BUSINESS_NODE_ENV) throw Error('Transient transport was not consumed');
const code="process.stdout.write(JSON.stringify([globalThis.businessPreload,require('business-only'),Error.stackTraceLimit]))";
const direct=execFileSync(process.execPath,['-e',code],{env:managedBusinessEnvironment(),encoding:'utf8'});
const quote=s=>"'"+s.replaceAll("'","'\\\\''")+"'";
const bash=execFileSync(${JSON.stringify(shell)},['--noprofile','--norc','-c',managedBashCommand(quote(process.execPath.replaceAll('\\\\','/'))+' -e '+quote(code))],{env:managedBashOptions({env:{...process.env}}).env,encoding:'utf8'});
console.log(JSON.stringify({direct:JSON.parse(direct),bash:JSON.parse(bash),override:managedBusinessEnvironment({NODE_OPTIONS:'--stack-trace-limit=7'}).NODE_OPTIONS}));
`, { NODE_OPTIONS: undefined, NODE_PATH: undefined, GRAPHER_BUSINESS_NODE_ENV: JSON.stringify(values) });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { direct: ['loaded', 42, 29], bash: ['loaded', 42, 29], override: '--stack-trace-limit=7' });
    for (const invalid of [[], null, { PATH: 'poison' }, { NODE_OPTIONS: 3 }]) {
      const refused = run(base(), "console.log('FACTORY_RAN')", { GRAPHER_BUSINESS_NODE_ENV: JSON.stringify(invalid) });
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /Invalid transient business Node binding/);
      assert.doesNotMatch(refused.stdout, /FACTORY_RAN/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('discovery preserves startup functions, readonly wrappers and aliases', () => {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-shell-wrappers-'));
  try {
    const startup = join(directory, 'startup.sh');
    writeFileSync(startup, `python() { printf 'host-python\\n'; }\npip() { printf 'host-pip\\n'; }\nreadonly -f pip\nshopt -s expand_aliases\nalias conda='printf "host-conda\\n"'\n`);
    const result = run(base(), `console.log(execFileSync(${JSON.stringify(shell)},['--noprofile','--norc','-c',managedBashCommand('python; pip; conda; type -t python3')],{env:managedBashOptions({env:{...process.env}}).env,encoding:'utf8'}).trim())`, {
      BASH_ENV: startup,
      GRAPHER_ENVIRONMENT_DISCOVERY: join(directory, 'observer.json'),
      GRAPHER_ENVIRONMENT_HELPER: process.execPath,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim().replaceAll('\r', ''), 'host-python\nhost-pip\nhost-conda\nfunction');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a managed shell without an explicit environment preserves PATH and shell controls', () => {
  const moduleUrl = JSON.stringify(module);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {managedBashOptions} from ${moduleUrl}; console.log(JSON.stringify(managedBashOptions({env:{PATH:'host-path',BASH_ENV:'host-startup',SHELLOPTS:'pipefail',TMPDIR:'host-tmp'}},true).env))`], {
    encoding: 'utf8', env: { ...process.env, GRAPHER_LAUNCH_BINDING: '', GRAPHER_EXECUTION_KIND: '' }, timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  const env = JSON.parse(result.stdout);
  assert.equal(env.PATH, 'host-path');
  assert.equal(env.BASH_ENV, 'host-startup');
  assert.equal(env.SHELLOPTS, 'pipefail');
  assert.equal(env.TMPDIR, 'host-tmp');
});

test('a source-direct Graph Node Agent retains host temp variables while private roles get cache scratch', () => {
  const moduleUrl = JSON.stringify(module);
  const cache = mkdtempSync(join(tmpdir(), 'grapher-bash-cache-'));
  const runOptions = (kind, agentKind) => spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {managedBashOptions} from ${moduleUrl}; console.log(JSON.stringify(managedBashOptions({env:{PATH:'host-path',XDG_CACHE_HOME:${JSON.stringify(cache)},TMPDIR:'host-tmp',TMP:'host-TMP',TEMP:'host-TEMP'}},true).env))`], {
      encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: cache, GRAPHER_LAUNCH_BINDING: '', GRAPHER_MODE: 'node', GRAPHER_EXECUTION_KIND: kind, GRAPHER_AGENT_KIND: agentKind }, timeout: 15000,
    });
  try {
    const source = runOptions('source', 'node');
    assert.equal(source.status, 0, source.stderr);
    const hostEnv = JSON.parse(source.stdout);
    assert.equal(hostEnv.TMPDIR, 'host-tmp');
    assert.equal(hostEnv.TMP, 'host-TMP');
    assert.equal(hostEnv.TEMP, 'host-TEMP');
    const graph = runOptions('graph', 'node');
    assert.equal(graph.status, 0, graph.stderr);
    const privateEnv = JSON.parse(graph.stdout);
    const scratch = `${cache.replace(/[\\/]+$/, '')}/tmp`;
    assert.equal(privateEnv.TMPDIR, scratch);
    assert.equal(privateEnv.TMP, scratch);
    assert.equal(privateEnv.TEMP, scratch);
  } finally { rmSync(cache, { recursive: true, force: true }); }
});

test('actual native Bash PATH has no implicit MSYS host bins and temporary exports do not rebind the next call', () => {
  const command = `${JSON.stringify(process.execPath.replaceAll('\\', '/'))} -p process.env.PATH`;
  const result = run(base(), `const execute=command=>execFileSync(${JSON.stringify(shell)},['--noprofile','--norc','-c',managedBashCommand(command)],{env:managedBashOptions({env:{...process.env}}).env,encoding:'utf8'}).trim(); execute('export PATH=/temporary'); console.log(execute(${JSON.stringify(command)}))`);
  assert.equal(result.status, 0, result.stderr);
  const canonical = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  assert.deepEqual(result.stdout.trim().split(delimiter).map(canonical), [canonical(dirname(process.execPath))]);
});

test('workspace cwd restoration works in Bash and Pi fallback POSIX sh', { skip: process.platform === 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-shell-cwd-'));
  const workspace = join(directory, 'workspace');
  const startupCwd = join(directory, 'startup cwd');
  const startup = join(directory, 'bash-env');
  const oldpwdStartup = join(directory, 'oldpwd-bash-env');
  try {
    mkdirSync(workspace);
    mkdirSync(startupCwd);
    writeFileSync(startup, `cd '${startupCwd.replaceAll("'", "'\\''")}'\ncd() { return 91; }\nshopt -s expand_aliases\nalias builtin='false'\n`);
    writeFileSync(oldpwdStartup, `export OLDPWD='${startupCwd.replaceAll("'", "'\\''")}'\n`);
    const command = managedBashCommand('pwd -P', workspace);
    for (const executable of ['/bin/bash', '/bin/sh']) {
      const result = execFileSync(executable, ['-c', command], {
        cwd: startupCwd,
        env: { ...process.env, BASH_ENV: startup },
        encoding: 'utf8',
      }).trim();
      assert.equal(realpathSync(result), realpathSync(workspace), executable);
      const previous = execFileSync(executable, ['-c', managedBashCommand('cd - >/dev/null && pwd -P', workspace)], {
        cwd: workspace,
        env: { ...process.env, BASH_ENV: oldpwdStartup },
        encoding: 'utf8',
      }).trim();
      assert.equal(realpathSync(previous), realpathSync(startupCwd), `${executable} must preserve cd -`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('symlinked PATH directories identify the declared entry directory', { skip: process.platform === 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-launch-alias-'));
  try {
    const real = join(directory, 'real');
    const alias = join(directory, 'alias');
    mkdirSync(real);
    symlinkSync(real, alias, 'dir');
    const entry = join(real, 'node');
    symlinkSync(process.execPath, entry);
    const result = run({ ...base(), entry, path: [alias] }, '');
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('failed activation, replaced default PATH and corrupted reserved variables fail closed', () => {
  for (const hook of ['exit 3', 'export PATH=/a-different-default']) {
    const result = run({ ...base(), hook }, "console.log('FACTORY_RAN')");
    assert.notEqual(result.status, 0); assert.doesNotMatch(result.stdout, /FACTORY_RAN/);
  }
  for (const key of ['NODE_OPTIONS', 'GRAPHER_MODE', 'PI_CODING_AGENT_DIR', 'PATH']) {
    const result = run({ ...base(), variables: { [key]: 'poison' } }, "console.log('FACTORY_RAN')");
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Invalid native launch/); assert.doesNotMatch(result.stdout, /FACTORY_RAN/);
  }
});

test('an explicit leased CUDA UUID overrides hook/device visibility before factories and Bash subprocesses', () => {
  const id = 'GPU-01234567-89ab-cdef-0123-456789abcdef';
  const launch = base(); launch.hook = `test "$CUDA_VISIBLE_DEVICES" = '${id}' || exit 9; export CUDA_VISIBLE_DEVICES=all-host-devices; export HIP_VISIBLE_DEVICES=0`;
  const result = run(launch, "const env=managedBashOptions({env:{CUDA_VISIBLE_DEVICES:'host-default'}}).env; const child=execFileSync(process.execPath,['-e','process.stdout.write(JSON.stringify({device:process.env.CUDA_VISIBLE_DEVICES,order:process.env.CUDA_DEVICE_ORDER,hip:process.env.HIP_VISIBLE_DEVICES}))'],{env,encoding:'utf8'}); console.log(JSON.stringify({device:process.env.CUDA_VISIBLE_DEVICES,order:process.env.CUDA_DEVICE_ORDER,hip:process.env.HIP_VISIBLE_DEVICES,child:JSON.parse(child)}))", {
    GRAPHER_ACCELERATOR_BINDING: JSON.stringify({ backend: 'cuda', ids: [id], probe: 'trusted-native-probe' }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    device: id, order: 'PCI_BUS_ID', hip: '',
    child: { device: id, order: 'PCI_BUS_ID', hip: '' },
  });
});

test('activation hooks and managed Bash environment retain external runtime paths', () => {
  const directory = mkdtempSync(join(tmpdir(), 'grapher-state-binding-'));
  try {
    const launch = base();
    launch.variables = { HOME: directory, USERPROFILE: directory, XDG_CACHE_HOME: join(directory, 'cache'), npm_config_cache: join(directory, 'npm') };
    launch.hook = 'export HOME=.; export USERPROFILE=.; export XDG_CACHE_HOME=.; export npm_config_cache=.';
    const result = run(launch, "const explicit=managedBashOptions({env:{HOME:'in-project',npm_config_cache:'in-project'}}).env; const implicit=managedBashOptions({}).env; console.log(JSON.stringify({home:process.env.HOME,cache:process.env.XDG_CACHE_HOME,explicit:explicit.HOME,npm:explicit.npm_config_cache,implicit:implicit.HOME}))");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { home: directory, cache: join(directory, 'cache'), explicit: directory, npm: join(directory, 'npm'), implicit: directory });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('unmanaged compatibility process has no binding or additional PATH processing', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {applyLaunchBinding,managedBashOptions} from ${JSON.stringify(module)}; applyLaunchBinding(); console.log(JSON.stringify(managedBashOptions({env:{PATH:'legacy'}})))`], {
    encoding: 'utf8', env: { ...process.env, GRAPHER_LAUNCH_BINDING: '' }, timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { env: { PATH: 'legacy' } });
  assert.ok(delimiter);
});
