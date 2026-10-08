// One-use, source-project process preparation. Do not construct a Pi session
// or run extension factories until Rust supplies the actual Run's binding.
import { realpathSync } from 'node:fs';
import { preparePiCli } from './pi-compat.ts';

const roles = new Set(['partition', 'planner', 'node']);
const bindingEnvironment = new Set([
  'GRAPHER_MODE', 'GRAPHER_EXECUTION_KIND', 'GRAPHER_SOURCE_ALIAS',
  'GRAPHER_WORKSPACE_ROOT', 'GRAPHER_ORIGINAL_ROOT', 'GRAPHER_GRAPH_PATH',
  'GRAPHER_PLANNER_RUN_ID', 'GRAPHER_ACTIVE_RUN_ID', 'GRAPHER_NODE_EXECUTION_ID', 'GRAPHER_NODE_NAME',
  'GRAPHER_COMPILER_PATH', 'PI_CODING_AGENT_DIR', 'GRAPHER_LAUNCH_BINDING', 'GRAPHER_ENVIRONMENT_DATA',
]);
const clearedEnvironment = new Set([
  'PI_MODEL', 'PI_THINKING', 'PI_PROVIDER', 'PI_REASONING_LEVEL', 'PI_SESSION_ID', 'PI_SESSION_FILE',
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT', 'GRAPHER_LAUNCH_BINDING',
]);
const valueArguments = new Set([
  '--mode', '--model', '--thinking', '--session-id', '--session-dir', '--system-prompt',
  '--append-system-prompt', '--extension', '--skill', '--tools', '--exclude-tools',
]);
const switches = new Set([
  '--no-prompt-templates', '--no-themes', '--approve', '--no-approve',
  '--no-extensions', '--no-skills', '--no-tools', '--no-context-files',
]);
const samePath = (left: string, right: string) => {
  const normalize = (path: string) => {
    if (process.platform !== 'win32') return realpathSync(path);
    const host = path.startsWith('\\\\?\\UNC\\') ? `\\\\${path.slice(8)}` : path.startsWith('\\\\?\\') ? path.slice(4) : path;
    return realpathSync.native(host).toLowerCase();
  };
  return normalize(left) === normalize(right);
};

// Unlike readline, this consumes exactly one line, even when the next RPC
// command shares the same pipe chunk. Leave all later bytes for Pi's RPC reader.
function controlLine(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const bytes: Buffer[] = [];
    let length = 0;
    const cleanup = () => {
      process.stdin.off('readable', read);
      process.stdin.off('end', end);
      process.stdin.off('error', error);
    };
    const error = (cause: Error) => { cleanup(); reject(cause); };
    const end = () => {
      cleanup();
      if (length) reject(new Error('Incomplete prepared-host command'));
      else resolve(null);
    };
    const read = () => {
      let byte: Buffer | null;
      while ((byte = process.stdin.read(1)) !== null) {
        if (byte[0] === 10) { cleanup(); resolve(Buffer.concat(bytes).toString('utf8')); return; }
        if (++length > 1024 * 1024) { error(new Error('Prepared-host command exceeded 1 MiB')); return; }
        bytes.push(byte);
      }
    };
    process.stdin.on('readable', read);
    process.stdin.once('end', end);
    process.stdin.once('error', error);
    if (process.stdin.readableEnded) end(); else read();
  });
}
const respond = (command: any, success: boolean, error?: string) => new Promise<void>((resolve, reject) => {
  process.stdout.write(`${JSON.stringify({ type: 'response', id: command?.id, command: command?.type, success, ...(error ? { error } : {}) })}\n`,
    cause => cause ? reject(cause) : resolve());
});

function validateBinding(value: any, role: string, cwd: string): asserts value is {
  args: string[]; environment: Record<string, string | null>; cwd: string;
} {
  if (value?.type !== 'grapher_bind' || value.role !== role || typeof value.cwd !== 'string' || !samePath(value.cwd, cwd)) {
    throw new Error('Prepared process role/project mismatch');
  }
  if (!Array.isArray(value.args) || !value.args.every((arg: unknown) => typeof arg === 'string' && !arg.includes('\0'))) {
    throw new Error('Invalid task arguments');
  }
  let rpc = false;
  let session = false;
  for (let index = 0; index < value.args.length; index++) {
    const arg = value.args[index];
    if (valueArguments.has(arg)) {
      const parameter = value.args[++index];
      if (typeof parameter !== 'string') throw new Error(`Missing ${arg} value`);
      if (arg === '--mode') { if (parameter !== 'rpc') throw new Error('Prepared tasks require RPC'); rpc = true; }
      if (arg === '--session-dir') session = !!parameter;
    } else if (!switches.has(arg) && !arg.startsWith('@')) throw new Error(`Unsupported prepared-task argument: ${arg}`);
  }
  if (!rpc || !session) throw new Error('Task requires RPC and its owned session directory');
  if (!value.environment || typeof value.environment !== 'object' || Array.isArray(value.environment)) throw new Error('Invalid task environment');
  for (const [key, entry] of Object.entries(value.environment)) {
    if (clearedEnvironment.has(key) && entry === null) continue;
    if (!bindingEnvironment.has(key) || typeof entry !== 'string' || entry.includes('\0')) throw new Error(`Unsupported task environment: ${key}`);
  }
  if (value.environment.GRAPHER_MODE !== role || value.environment.GRAPHER_EXECUTION_KIND !== 'source') throw new Error('Task role/source binding required');
  for (const key of ['GRAPHER_WORKSPACE_ROOT', 'GRAPHER_ORIGINAL_ROOT', 'GRAPHER_SOURCE_ALIAS']) {
    if (!value.environment[key] || !samePath(value.environment[key], cwd)) throw new Error(`Invalid ${key}`);
  }
}

export async function bindPreparedHost(role: string): Promise<string[] | null> {
  if (!roles.has(role)) throw new Error('Unsupported prepared role');
  const cwd = process.cwd();
  // Do not inherit an outer Run's identity. Factories are only loaded after bind.
  for (const key of ['GRAPHER_GRAPH_PATH', 'GRAPHER_PLANNER_RUN_ID', 'GRAPHER_ACTIVE_RUN_ID', 'GRAPHER_NODE_EXECUTION_ID', 'GRAPHER_NODE_NAME', 'GRAPHER_COMPILER_PATH']) delete process.env[key];
  await preparePiCli();
  const first = await controlLine();
  if (first === null) return null;
  const prepare = JSON.parse(first);
  if (prepare.type !== 'grapher_prepare' || prepare.role !== role) {
    await respond(prepare, false, 'Expected matching grapher_prepare');
    throw new Error('Invalid preparation handshake');
  }
  await respond(prepare, true);
  const line = await controlLine();
  if (line === null) return null;
  const binding = JSON.parse(line);
  try { validateBinding(binding, role, cwd); }
  catch (error) { await respond(binding, false, String(error)); throw error; }
  for (const [key, entry] of Object.entries(binding.environment)) {
    if (entry === null) delete process.env[key]; else process.env[key] = entry;
  }
  process.chdir(binding.cwd);
  process.argv = [process.argv[0], process.argv[1], ...binding.args];
  await respond(binding, true);
  // One binding only. No control reader remains; execution-cli now builds the
  // exact ordinary Pi session and Rust must verify get_state before prompting.
  return binding.args;
}
