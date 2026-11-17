// Grapher-owned launch boundary. Applied before extension/MCP factories, not
// merely in one Bash subprocess. Hooks are part of the frozen native policy,
// not a frontend/user environment-selection surface.
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, isAbsolute, dirname, resolve } from 'node:path';
import { samePath, toHostInput } from './path-identity.mjs';

let active;
let activePath;
const initialLocalAppData = process.env.LOCALAPPDATA;
let deviceEnvironment = {};
let businessNodeEnvironment = {};
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
const isNativeAbsolute = value => typeof value === 'string' && isAbsolute(value)
  && (process.platform !== 'win32' || /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(value));
// Match Rust std::env::{join_paths,split_paths}, not Node's simpler NODE_PATH
// delimiter grammar. Windows PATH can quote a directory containing ';'.
function splitNativePath(value) {
  if (process.platform !== 'win32') return value.split(delimiter);
  const paths = [];
  let entry = '', quoted = false;
  for (const character of value) {
    if (character === '"') quoted = !quoted;
    else if (character === ';' && !quoted) { paths.push(entry); entry = ''; }
    else entry += character;
  }
  paths.push(entry);
  return paths;
}
function joinNativePath(paths) {
  return paths.map(entry => {
    if (process.platform === 'win32') {
      if (/["\r\n]/.test(entry)) throw new Error('Invalid native PATH entry');
      return entry.includes(';') ? `"${entry}"` : entry;
    }
    if (entry.includes(delimiter)) throw new Error('Invalid native PATH entry');
    return entry;
  }).join(delimiter);
}
const isEntryFirst = launch => !launch.inheritAmbient || launch.environment != null || launch.hook != null;
const windowsSystemDirs = process.platform !== 'win32' ? [] : [
  ...[process.env.SystemRoot, process.env.WINDIR]
    .filter(Boolean)
    .flatMap(root => ['System32', 'Sysnative', 'SysWOW64'].map(sub => resolve(root, sub))),
  ...(initialLocalAppData ? [resolve(initialLocalAppData, 'Microsoft/WindowsApps')] : []),
];
function isWindowsSystemToolDir(entry) {
  return isNativeAbsolute(entry) && (
    windowsSystemDirs.some(dir => samePath(entry, dir))
    || /[\\/]appdata[\\/]local[\\/]microsoft[\\/]windowsapps[\\/]*$/i.test(entry)
  );
}
// Git Bash disables its own /mingw64/bin:/usr/bin startup prepend here so
// business PATH entries win, yet System32 / WindowsApps carry WSL bash.exe
// plus Windows find/sort; keep the shell's own bins ahead of those OS dirs.
function bashPathEntries(path, launch = active) {
  const entries = splitNativePath(path).map(entry => entry || '.');
  if (process.platform !== 'win32') return entries;
  if (entries.some(entry => /[\r\n]/.test(entry))) throw new Error('Invalid native PATH entry');
  if (!launch?.shell) return entries;
  const start = isEntryFirst(launch) ? 1 : 0;
  const osIndex = entries.findIndex((entry, index) => index >= start && isWindowsSystemToolDir(entry));
  if (osIndex < 0) return entries;
  const shellDir = dirname(launch.shell);
  const shellBins = [shellDir, resolve(shellDir, '../usr/bin')];
  const promoted = [];
  const rest = [];
  entries.forEach((entry, index) => {
    if (index > osIndex && isNativeAbsolute(entry) && shellBins.some(bin => samePath(entry, bin))) {
      promoted.push(entry);
    } else {
      rest.push(entry);
    }
  });
  return promoted.length ? [...rest.slice(0, osIndex), ...promoted, ...rest.slice(osIndex)] : entries;
}
function bindBashPath(path, { launch = active, entries = bashPathEntries(path, launch) } = {}) {
  // Native Git Bash's MSYS startup prepends host bins even with --noprofile.
  // Reset PATH INSIDE Bash, using the trusted shell installation's converter.
  if (process.platform === 'win32') {
    // Convert separate arguments in ONE process. cygpath -p does not honor
    // native PATH quotes and drops empty entries; '.' retains cwd semantics.
    return `__grapher_path=$(/usr/bin/cygpath -u -- ${entries.map(quote).join(' ')}) || exit $?\ncase "$__grapher_path" in *:*) printf '%s\\n' 'Native PATH entry cannot be represented in Bash' >&2; exit 1;; esac\nexport PATH="\${__grapher_path//$'\\n'/:}"\nunset __grapher_path\n`;
  }
  return `export PATH=${quote(path)}\n`;
}
// MSYS converts PATH on native process startup, but that transport cannot
// quote ';' directories and can absolutize relative entries. Capture Bash's
// list separately. Keep original native spellings, and convert only new
// absolute entries in one trusted converter call; relative entries stay relative.
const hookPathMarker = '\0GRAPHER_HOOK_PATH\0';
const captureHookPath = process.platform !== 'win32' ? '' : `
__grapher_hook_native=''
__grapher_hook_absolute=()
if [ "\${PATH+x}" = x ]; then
  case "$PATH" in *$'\\n'*|*$'\\r'*) \\builtin printf '%s\\n' 'Invalid activation PATH entry' >&2; exit 1;; esac
  __grapher_hook_remaining="$PATH:"
  while [ -n "$__grapher_hook_remaining" ]; do
    __grapher_hook_entry="\${__grapher_hook_remaining%%:*}"
    __grapher_hook_remaining="\${__grapher_hook_remaining#*:}"
    case "$__grapher_hook_entry" in
      /*) case ":$__grapher_hook_initial_path:" in
        *":$__grapher_hook_entry:"*) ;;
        *) __grapher_hook_absolute+=("$__grapher_hook_entry");;
      esac;;
    esac
  done
  if [ "\${#__grapher_hook_absolute[@]}" -gt 0 ]; then
    __grapher_hook_native=$(/usr/bin/cygpath -w -- "\${__grapher_hook_absolute[@]}") || exit $?
  fi
fi
\\builtin printf '\\0GRAPHER_HOOK_PATH\\0%s\\0%s\\0%s\\0%s\\0' "$__grapher_hook_initial_path" "\${PATH+x}" "\${PATH-}" "$__grapher_hook_native"
unset __grapher_hook_initial_path __grapher_hook_native __grapher_hook_absolute __grapher_hook_remaining __grapher_hook_entry
`;
function capturedHookPath(output, original, initialNative = original) {
  let offset = output.lastIndexOf(hookPathMarker);
  if (offset < 0) throw new Error('Native hook did not produce a complete PATH');
  offset += hookPathMarker.length;
  const fields = [];
  for (let index = 0; index < 4; index++) {
    const end = output.indexOf('\0', offset);
    if (end < 0) throw new Error('Native hook did not produce a complete PATH');
    fields.push(output.slice(offset, end));
    offset = end + 1;
  }
  const [initial, present, path, converted] = fields;
  const entries = initial.split(':');
  if (entries.length !== initialNative.length || !['', 'x'].includes(present)) throw new Error('Invalid native hook PATH capture');
  if (!present) return undefined;
  if (path === initial) return joinNativePath(original);
  const known = new Map();
  entries.forEach((entry, index) => { if (!known.has(entry)) known.set(entry, initialNative[index]); });
  const paths = path.split(':');
  const unknown = paths.filter(entry => entry.startsWith('/') && !known.has(entry));
  const native = unknown.length ? converted.split('\n') : [];
  if (native.length !== unknown.length || !unknown.length && converted !== ''
      || native.some(entry => !isNativeAbsolute(entry))) throw new Error('Invalid converted hook PATH entries');
  let index = 0;
  return joinNativePath(paths.map(entry => known.has(entry) ? known.get(entry)
    : entry.startsWith('/') ? native[index++] : entry));
}
function restoreBashCwd(workspaceCwd) {
  if (workspaceCwd === undefined) return '';
  if (typeof workspaceCwd !== 'string' || workspaceCwd.includes('\0') || !isAbsolute(workspaceCwd)) {
    throw new Error('Invalid Bash workspace cwd');
  }
  // BASH_ENV runs first. Retain its setup, but restore the selected directory
  // before path conversion and before any relative tool/activation-hook work.
  // A redundant cd overwrites OLDPWD (and can fail when it is readonly).
  // Compare physical directories so trusted root aliases need no extra cd.
  const path = process.platform === 'win32' ? toHostInput(workspaceCwd).replaceAll('\\', '/') : workspaceCwd;
  return `if [ -n "\${BASH_VERSION-}\${ZSH_VERSION-}" ]; then\nif ! \\builtin test . -ef ${quote(path)}; then\n\\builtin cd -- ${quote(path)} || exit $?\nfi\nelse\nif ! [ . -ef ${quote(path)} ]; then\ncd -- ${quote(path)} || exit $?\nfi\nfi\n`;
}
export function managedBashCommand(command, workspaceCwd) {
  const restoreWorkspace = restoreBashCwd(workspaceCwd);
  if (!active) return restoreWorkspace + command;
  let observer = '';
  if (process.env.GRAPHER_ENVIRONMENT_DISCOVERY) {
    const helper = process.env.GRAPHER_ENVIRONMENT_HELPER;
    const context = process.env.GRAPHER_ENVIRONMENT_DISCOVERY;
    if (!helper || !isAbsolute(helper) || !isAbsolute(context)) throw new Error('Missing native environment observer binding');
    // Instrument native tool argv/resolution, never parse model Shell text.
    // Each invocation is scoped to this Bash; temporary exports are not L.
    observer = `__grapher_env_tool() { local __grapher_tool="$1"; shift; local __grapher_exe; __grapher_exe=$(type -P "$__grapher_tool") || return 127; ${quote(helper.replaceAll('\\', '/'))} --grapher-env-tool ${quote(context.replaceAll('\\', '/'))} "$__grapher_tool" "$__grapher_exe" "$@"; }\n`;
    for (const tool of ['python', 'python3', 'pip', 'pip3', 'conda']) {
      // Provenance must not replace business wrappers/activation functions.
      // Delay parsing the definition so an existing alias cannot expand inside
      // a skipped function declaration (BASH_ENV may enable expand_aliases).
      const definition = `${tool}() { __grapher_env_tool ${tool} "$@"; }`;
      observer += `case "$(type -t ${tool} 2>/dev/null || true)" in\nfunction|alias) ;;\n*) eval ${quote(definition)} ;;\nesac\n`;
    }
  }
  return restoreWorkspace + bindBashPath(activePath) + observer + command;
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
  if (!isNativeAbsolute(launch.entry) ||
      !isNativeAbsolute(launch.shell) || !existsSync(launch.shell) ||
      !Array.isArray(launch.path) || !launch.path.length || !launch.path.every(value => typeof value === 'string' && !value.includes('\0') && (launch.unboundPath != null || isNativeAbsolute(value))) ||
      launch.unboundPath != null && (!Array.isArray(launch.unboundPath) || !launch.unboundPath.length || !launch.unboundPath.every(value => typeof value === 'string' && !value.includes('\0'))) ||
      !launch.variables || typeof launch.variables !== 'object' || Array.isArray(launch.variables) ||
      Object.entries(launch.variables).some(([key, value]) => protectedKeys(key) || !/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) ||
      launch.inheritAmbient != null && typeof launch.inheritAmbient !== 'boolean' ||
      launch.hook != null && (typeof launch.hook !== 'string' || launch.hook.includes('\0'))) {
    throw new Error('Invalid native launch binding');
  }
  // Windows env keys are case-insensitive. Keep exactly one PATH spelling.
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase() === 'PATH') delete process.env[key];
  }
  process.env.PATH = joinNativePath(launch.path);
  const loaders = JSON.parse(process.env.GRAPHER_BUSINESS_LOADER_ENV || '{}');
  delete process.env.GRAPHER_BUSINESS_LOADER_ENV;
  for (const [key, value] of Object.entries(loaders)) {
    if (!/^(LD_|DYLD_)/i.test(key) || typeof value !== 'string') throw new Error('Invalid transient business loader binding');
    process.env[key] = value;
  }
  const nodeEnvironment = JSON.parse(process.env.GRAPHER_BUSINESS_NODE_ENV || '{}');
  delete process.env.GRAPHER_BUSINESS_NODE_ENV;
  if (!nodeEnvironment || typeof nodeEnvironment !== 'object' || Array.isArray(nodeEnvironment)) throw new Error('Invalid transient business Node binding');
  businessNodeEnvironment = {};
  for (const [name, value] of Object.entries(nodeEnvironment)) {
    const key = process.platform === 'win32' ? name.toUpperCase() : name;
    if (!['NODE_OPTIONS', 'NODE_PATH'].includes(key) || typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid transient business Node binding');
    businessNodeEnvironment[key] = value;
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
    const hookEntries = bashPathEntries(process.env.PATH, launch);
    // Do not use an env/python/node found on the business PATH for capture.
    const output = spawnSync(launch.shell, ['--noprofile', '--norc', '-c',
      `${restoreBashCwd(process.cwd())}${bindBashPath(process.env.PATH, { launch, entries: hookEntries })}${process.platform === 'win32' ? '__grapher_hook_initial_path=$PATH\n' : ''}${launch.hook}\n__grapher_status=$?\nif [ "$__grapher_status" -ne 0 ]; then exit "$__grapher_status"; fi\nwhile IFS= read -r __grapher_key; do\ncase "$__grapher_key" in\n[Nn][Oo][Dd][Ee]_[Oo][Pp][Tt][Ii][Oo][Nn][Ss]|[Nn][Oo][Dd][Ee]_[Pp][Aa][Tt][Hh]|[Bb][Aa][Ss][Hh]_[Ee][Nn][Vv]|[Ee][Nn][Vv]) unset "$__grapher_key";;\nesac\ndone < <(compgen -e)\n${captureHookPath}${quote(node)} -e ${quote(capture)}`],
    { cwd: process.cwd(), env: { ...process.env }, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    if (output.error || output.status !== 0) throw new Error('Declared native activation hook failed; no fallback');
    const marker = '\0GRAPHER_ENV\0';
    const start = output.stdout.lastIndexOf(marker);
    const end = output.stdout.indexOf('\0', start + marker.length);
    if (start < 0 || end < 0) throw new Error('Native hook did not produce a complete environment');
    const environment = JSON.parse(output.stdout.slice(start + marker.length, end));
    if (process.platform === 'win32') {
      const path = capturedHookPath(output.stdout.slice(0, start), launch.path, hookEntries);
      for (const key of Object.keys(environment)) if (/^PATH$/i.test(key)) delete environment[key];
      if (path !== undefined) environment.PATH = path;
    }
    // A hook cannot change Runtime/Pi identity or install Node bootstrap code.
    const identityKey = key => protectedKeys(key) && key.toUpperCase() !== 'PATH';
    for (const key of Object.keys(process.env)) if (!identityKey(key)) delete process.env[key];
    for (const [key, value] of Object.entries(environment)) if (!identityKey(key)) process.env[key] = value;
  }
  // Resolve existing directories and filesystem identity so macOS /var aliases,
  // symlinked environments, case-insensitive volumes and Windows spellings
  // still identify the same declared PATH root.

  // The unbound automatic entry is an absolute Bash, not a reason to put
  // Git/Bash's bundled tools ahead of the user's business executables.
  const entryFirst = isEntryFirst(launch);
  const firstPath = typeof process.env.PATH === 'string' ? splitNativePath(process.env.PATH)[0] : undefined;
  if (!existsSync(launch.entry) || !statSync(launch.entry).isFile() || typeof process.env.PATH !== 'string' ||
      entryFirst && (!isNativeAbsolute(firstPath) || !samePath(firstPath, dirname(launch.entry)))) {
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
// install directory). Grapher-owned keys, Pi session paths and selected editor
// breadcrumbs are dropped; temp bindings use safe cache scratch when available.
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
/** Strip Grapher-owned and selected Pi paths; returns an optional temp scratch to create. */
export function scrubModelShellEnvironment(env, { useCacheScratch = true } = {}) {
  const scratch = useCacheScratch ? modelShellScratch(env) : undefined;
  for (const key of Object.keys(env)) {
    if (grapherInternalKey.test(key) || hiddenModelKeys.has(key.toUpperCase())) delete env[key];
  }
  for (const key of ['TMPDIR', 'TMP', 'TEMP', 'XDG_RUNTIME_DIR']) {
    if (scratch) env[key] = scratch;
    else if (typeof env[key] === 'string' && dataPathComponent.test(env[key])) delete env[key];
  }
  return scratch;
}
/** Business Node settings never enter the trusted host/factory or hook-capture process. */
export function managedBusinessEnvironment(environment = process.env) {
  const env = { ...environment };
  for (const [key, value] of Object.entries(businessNodeEnvironment)) {
    const explicit = Object.keys(env).some(name => process.platform === 'win32' ? name.toUpperCase() === key : name === key);
    if (!explicit) env[key] = value;
  }
  return env;
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
  const env = managedBusinessEnvironment(options.env ?? process.env);
  env.PYTHONDONTWRITEBYTECODE = '1';
  if (active) {
    for (const key of Object.keys(env)) if (/^PATH$/i.test(key)) delete env[key];
    env.PATH = activePath;
  }
  Object.assign(env, runtimeEnvironment, deviceEnvironment);
  const originalTemp = Object.fromEntries(['TMPDIR', 'TMP', 'TEMP', 'XDG_RUNTIME_DIR'].map(key => [key, env[key]]));
  const sourceNativeNode = process.env.GRAPHER_MODE === 'node'
    && process.env.GRAPHER_AGENT_KIND === 'node'
    && process.env.GRAPHER_EXECUTION_KIND === 'source';
  const scratch = scrubModelShellEnvironment(env, {
    // A source-direct Graph Node Agent keeps host temp variables like Serial.
    // Private Graph and Planner roles bind a safe Run-cache scratch instead.
    useCacheScratch: !sourceNativeNode,
  });
  if (scratch) {
    // 0o700: the scratch is also XDG_RUNTIME_DIR, which the spec requires to be
    // private. Ignored on Windows; the parent cache dir already exists, so only
    // the leaf is created here.
    try { mkdirSync(toHostInput(scratch), { recursive: true, mode: 0o700 }); }
    catch {
      for (const key of ['TMPDIR', 'TMP', 'TEMP', 'XDG_RUNTIME_DIR']) {
        const value = originalTemp[key];
        if (typeof value === 'string' && !dataPathComponent.test(value)) env[key] = value;
        else delete env[key];
      }
    }
  }
  return { ...options, env };
}
