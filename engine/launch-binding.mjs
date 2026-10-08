// Grapher-owned launch boundary. Applied before extension/MCP factories, not
// merely in one Bash subprocess. Hooks are part of the frozen native policy,
// not a frontend/user environment-selection surface.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, isAbsolute, dirname, resolve } from 'node:path';

let active;
let activePath;
let deviceEnvironment = {};
export function managedLaunch() { return active; }

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
  const protectedKeys = key => /^(GRAPHER_|PI_|GIT_)/i.test(key) || /^(PATH|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|SHELLOPTS|BASHOPTS)$/i.test(key);
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
  const canonical = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  if (!existsSync(launch.entry) || !statSync(launch.entry).isFile() ||
      canonical(process.env.PATH?.split(delimiter)[0] || '') !== canonical(dirname(launch.entry))) {
    throw new Error('Declared default entry/PATH is unavailable or changed by the hook; no fallback');
  }
  Object.assign(process.env, deviceEnvironment);
  activePath = process.env.PATH;
  active = Object.freeze(launch);
}

// Pi prepends its managed search-bin directory in getShellEnv(). For managed
// business execution, preserve the configured PATH after that second processing.
// read/write/edit/search remain in the same cwd; only Bash launch is overridden.
export function managedBashOptions(options) {
  if (!active) return options;
  const env = { ...options.env };
  for (const key of Object.keys(env)) if (/^(PATH|BASH_ENV|ENV|SHELLOPTS|BASHOPTS)$/i.test(key)) delete env[key];
  env.PATH = activePath;
  Object.assign(env, deviceEnvironment);
  return { ...options, env };
}
