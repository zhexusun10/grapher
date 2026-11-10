// Grapher-owned launch boundary. Applied before extension/MCP factories, not
// merely in one Bash subprocess. Hooks are part of the frozen native policy,
// not a frontend/user environment-selection surface.
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, isAbsolute, dirname } from 'node:path';
import { samePath, toHostInput } from './path-identity.mjs';

let active;
let activePath;
let deviceEnvironment = {};
const runtimePathKey = key => /^(HOME|USERPROFILE|APPDATA|LOCALAPPDATA|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_CACHE_HOME|TMPDIR|TMP|TEMP|XDG_RUNTIME_DIR|npm_config_cache|PIP_CACHE_DIR|CONDA_ENVS_PATH|CONDA_PKGS_DIRS)$/i.test(key);
const workspaceBindingKey = key => runtimePathKey(key) || /^(GIT_CONFIG_GLOBAL|GIT_CEILING_DIRECTORIES)$/i.test(key);
let runtimeEnvironment = process.env.GRAPHER_EXECUTION_KIND === 'graph'
  ? Object.fromEntries(Object.entries(process.env).filter(([key]) => workspaceBindingKey(key))) : {};
export function managedLaunch() { return active; }

// Values come from the backend's current physical-slot target, not a frontend
// environment choice. Planner uses host tools rather than a node's activation L.
export function rebindWorkspaceEnvironment(bindings, workspace) {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)
      || !bindings.HOME || !bindings.GIT_CONFIG_GLOBAL || !bindings.GIT_CEILING_DIRECTORIES
      || Object.entries(bindings).some(([key, value]) => !workspaceBindingKey(key)
        || typeof value !== 'string' || value.includes('\0') || !isAbsolute(value))) {
    throw new Error('Invalid backend workspace runtime binding');
  }
  if (active) throw new Error('Managed business launch requires its own full backend rebind');
  if (workspace) process.chdir(workspace);
  Object.assign(runtimeEnvironment, bindings);
  Object.assign(process.env, bindings);
}

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
function bindBashPath(path) {
  // Native Git Bash's MSYS startup prepends host bins even with --noprofile.
  // Reset PATH INSIDE Bash, using the trusted shell installation's converter.
  if (process.platform === 'win32') return `__grapher_path=$(/usr/bin/cygpath -u -p ${quote(path)}) || exit $?\nexport PATH="$__grapher_path"\nunset __grapher_path\n`;
  return `export PATH=${quote(path)}\n`;
}
export function managedBashCommand(command) {
  if (!active) return command;
  let observer = '';
  if (process.env.GRAPHER_ENVIRONMENT_DISCOVERY) {
    const helper = process.env.GRAPHER_ENVIRONMENT_HELPER;
    const context = process.env.GRAPHER_ENVIRONMENT_DISCOVERY;
    if (!helper || !isAbsolute(helper) || !isAbsolute(context)) throw new Error('Missing native environment observer binding');
    // Instrument native tool argv/resolution, never parse model Shell text.
    // Each invocation is scoped to this Bash; temporary exports are not L.
    observer = `__grapher_env_tool() { local __grapher_tool="$1"; shift; local __grapher_exe; __grapher_exe=$(type -P "$__grapher_tool") || return 127; ${quote(helper.replaceAll('\\', '/'))} --grapher-env-tool ${quote(context.replaceAll('\\', '/'))} "$__grapher_tool" "$__grapher_exe" "$@"; }\n`;
    for (const tool of ['python', 'python3', 'pip', 'pip3', 'conda']) observer += `${tool}() { __grapher_env_tool ${tool} "$@"; }\n`;
  }
  return bindBashPath(activePath) + observer + command;
}

export function applyLaunchBinding(file = process.env.GRAPHER_LAUNCH_BINDING) {
  if (!file) return;
  const launch = JSON.parse(readFileSync(file, 'utf8'));
  // Runtime-owned identity/policy variables. PYTHONDONTWRITEBYTECODE is a host
  // invariant (no interpreter bytecode inside the project tree that `stage_scoped`
  // would then force-collect into Git), so declared variables and activation
  // hooks may neither set nor delete it.
  const protectedKeys = key => /^(GRAPHER_|PI_|GIT_)/i.test(key)
    || key.toUpperCase() === 'PYTHONDONTWRITEBYTECODE'
    || /^(PATH|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|CDPATH|OLDPWD|GLOBIGNORE)$/i.test(key);
  if (typeof launch.entry !== 'string' || !isAbsolute(launch.entry) ||
      typeof launch.shell !== 'string' || !isAbsolute(launch.shell) || !existsSync(launch.shell) ||
      !Array.isArray(launch.path) || !launch.path.length || !launch.path.every(value => typeof value === 'string' && isAbsolute(value)) ||
      !launch.variables || typeof launch.variables !== 'object' || Array.isArray(launch.variables) ||
      Object.entries(launch.variables).some(([key, value]) => protectedKeys(key) || !/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) ||
      launch.hook != null && (typeof launch.hook !== 'string' || launch.hook.includes('\0'))) {
    throw new Error('Invalid native launch binding');
  }
  // Windows env keys are case-insensitive. Keep exactly one PATH spelling.
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase() === 'PATH') delete process.env[key];
  }
  process.env.PATH = launch.path.join(delimiter);
  const loaders = JSON.parse(process.env.GRAPHER_BUSINESS_LOADER_ENV || '{}');
  delete process.env.GRAPHER_BUSINESS_LOADER_ENV;
  for (const [key, value] of Object.entries(loaders)) {
    if (!/^(LD_|DYLD_)/i.test(key) || typeof value !== 'string') throw new Error('Invalid transient business loader binding');
    process.env[key] = value;
  }
  for (const [key, value] of Object.entries(launch.variables)) process.env[key] = value;
  runtimeEnvironment = Object.fromEntries(Object.entries(launch.variables).filter(([key]) => runtimePathKey(key)));
  if (process.env.GRAPHER_EXECUTION_KIND === 'graph') {
    for (const [key, value] of Object.entries(process.env)) {
      if (runtimePathKey(key) || /^(GIT_CONFIG_GLOBAL|GIT_CEILING_DIRECTORIES)$/i.test(key)) runtimeEnvironment[key] = value;
    }
  }
  const device = process.env.GRAPHER_ACCELERATOR_BINDING && JSON.parse(process.env.GRAPHER_ACCELERATOR_BINDING);
  deviceEnvironment = {};
  if (device) {
    if (device.backend !== 'cuda' || !Array.isArray(device.ids) || !device.ids.length || device.ids.some(id => !/^GPU-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))) {
      throw new Error('Invalid leased accelerator binding; no device fallback');
    }
    deviceEnvironment = { CUDA_VISIBLE_DEVICES: device.ids.join(','), CUDA_DEVICE_ORDER: 'PCI_BUS_ID', HIP_VISIBLE_DEVICES: '', ROCR_VISIBLE_DEVICES: '' };
    // Activation subprocesses start in the lease too; hooks cannot rebind the
    // subsequent factory/tool view because the binding is applied again below.
    Object.assign(process.env, deviceEnvironment);
  }
  if (launch.hook) {
    const node = process.execPath.replaceAll('\\', '/');
    const capture = `process.stdout.write('\\0GRAPHER_ENV\\0'+JSON.stringify(process.env)+'\\0')`;
    // Do not use an env/python/node found on the business PATH for capture.
    const output = spawnSync(launch.shell, ['--noprofile', '--norc', '-c',
      `${bindBashPath(process.env.PATH)}${launch.hook}\n__grapher_status=$?\nif [ "$__grapher_status" -ne 0 ]; then exit "$__grapher_status"; fi\nwhile IFS= read -r __grapher_key; do\ncase "$__grapher_key" in\n[Nn][Oo][Dd][Ee]_[Oo][Pp][Tt][Ii][Oo][Nn][Ss]|[Nn][Oo][Dd][Ee]_[Pp][Aa][Tt][Hh]|[Bb][Aa][Ss][Hh]_[Ee][Nn][Vv]|[Ee][Nn][Vv]) unset "$__grapher_key";;\nesac\ndone < <(compgen -e)\n${quote(node)} -e ${quote(capture)}`],
    { cwd: process.cwd(), env: { ...process.env }, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    if (output.error || output.status !== 0) throw new Error('Declared native activation hook failed; no fallback');
    const marker = '\0GRAPHER_ENV\0';
    const start = output.stdout.lastIndexOf(marker);
    const end = output.stdout.indexOf('\0', start + marker.length);
    if (start < 0 || end < 0) throw new Error('Native hook did not produce a complete environment');
    const environment = JSON.parse(output.stdout.slice(start + marker.length, end));
    // A hook cannot change Runtime/Pi identity or install Node bootstrap code.
    const identityKey = key => protectedKeys(key) && key.toUpperCase() !== 'PATH';
    for (const key of Object.keys(process.env)) if (!identityKey(key)) delete process.env[key];
    for (const [key, value] of Object.entries(environment)) if (!identityKey(key)) process.env[key] = value;
  }
  // Resolve existing directories and filesystem identity so macOS /var aliases,
  // symlinked environments, case-insensitive volumes and Windows spellings
  // still identify the same declared PATH root.

  if (!existsSync(launch.entry) || !statSync(launch.entry).isFile() ||
      !samePath(process.env.PATH?.split(delimiter)[0] || '', dirname(launch.entry))) {
    throw new Error('Declared default entry/PATH is unavailable or changed by the hook; no fallback');
  }
  // Activation may alter business variables, not the runtime's external HOME,
  // cache/temp or project-Git bindings. Reapply them before any factory/tool.
  Object.assign(process.env, runtimeEnvironment, deviceEnvironment);
  process.env.PYTHONDONTWRITEBYTECODE = '1';
  activePath = process.env.PATH;
  active = Object.freeze(launch);
}

// Pi prepends its managed search-bin directory in getShellEnv(). For managed
// business execution, preserve the configured PATH after that second processing.
//
// The model's shell is the one place Grapher's own control paths must not appear:
// a single `env` otherwise hands the agent the Run's `data/` and `.grapher-state/`
// layout, which it can then walk into (other nodes' sessions, graph Git, the
// install directory). Grapher-owned keys are dropped, Pi session/credential keys
// are dropped (pi-trim removed the "inspect PI_*" guidance, so the shell needs
// none of them), and session-directory temp bindings are retargeted to the Run's
// cache scratch, which never reveals `data/`.
//
// The host Git credential helper (GIT_ASKPASS and the VSCODE_GIT_ASKPASS_* the
// askpass script reads) is deliberately KEPT: a task that authenticates to a
// private remote must still work. Only path-free editor breadcrumbs are dropped.
// (Git for Windows re-injects PLINK_PROTOCOL=ssh at shell startup; it carries no
// path, so it is left alone rather than fought.)
const grapherInternalKey = /^GRAPHER_/i;
const hiddenModelKeys = new Set([
  // Pi session/credential paths and identity the shell never needs.
  'PI_SESSION_FILE', 'PI_SESSION_ID', 'PI_CODING_AGENT_DIR',
  // Path-free host editor/terminal breadcrumbs with no functional value here.
  'VSCODE_INJECTION', 'VSCODE_PYTHON_AUTOACTIVATE_GUARD',
  'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'ANTIGRAVITY_CLI_ALIAS',
]);
const dataPathComponent = /[\\/]data(?:[\\/]|$)/i;
function modelShellScratch(env) {
  for (const key of ['XDG_CACHE_HOME', 'GRAPHER_CACHE_DIR']) {
    const value = env[key];
    if (typeof value === 'string' && value && !value.includes('\0') && !dataPathComponent.test(value)) {
      return `${value.replace(/[\\/]+$/, '')}/tmp`;
    }
  }
  return undefined;
}
/** Strip Grapher-owned paths from the shell env; returns the temp scratch to create. */
export function scrubModelShellEnvironment(env) {
  const scratch = modelShellScratch(env);
  for (const key of Object.keys(env)) {
    if (grapherInternalKey.test(key) || hiddenModelKeys.has(key.toUpperCase())) delete env[key];
  }
  for (const key of ['TMPDIR', 'TMP', 'TEMP', 'XDG_RUNTIME_DIR']) {
    if (scratch) env[key] = scratch;
    else delete env[key];
  }
  return scratch;
}
/**
 * Build the model's shell environment. `managed` marks a Grapher role process
 * (always true from the workspace policy); the unmanaged compatibility process
 * passes nothing and keeps the historical no-op behavior.
 */
export function managedBashOptions(options, managed = false) {
  if (!active && !Object.keys(runtimeEnvironment).length && !managed) return options;
  // The bash tool supplies the full shell environment; Pi's user_bash path may
  // omit it entirely. Keep the same Runtime bytecode policy in both cases.
  const env = { ...(options.env ?? process.env) };
  env.PYTHONDONTWRITEBYTECODE = '1';
  for (const key of Object.keys(env)) if (/^(BASH_ENV|ENV|SHELLOPTS|BASHOPTS|CDPATH|OLDPWD|GLOBIGNORE)$/i.test(key) || active && /^PATH$/i.test(key)) delete env[key];
  if (active) env.PATH = activePath;
  Object.assign(env, runtimeEnvironment, deviceEnvironment);
  const scratch = scrubModelShellEnvironment(env);
  if (scratch) {
    // 0o700: the scratch is also XDG_RUNTIME_DIR, which the spec requires to be
    // private. Ignored on Windows; the parent cache dir already exists, so only
    // the leaf is created here.
    try { mkdirSync(toHostInput(scratch), { recursive: true, mode: 0o700 }); }
    catch { for (const key of ['TMPDIR', 'TMP', 'TEMP', 'XDG_RUNTIME_DIR']) delete env[key]; }
  }
  return { ...options, env };
}
