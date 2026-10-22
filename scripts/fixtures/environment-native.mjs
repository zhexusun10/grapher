// Disposable native-acceptance fixtures, not production environment policy.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

export function venvCreationCommand(python, prefix = '.venv') {
  const directory = dirname(python).replaceAll('\\', '/');
  const bin = process.platform === 'win32'
    ? `"$(/usr/bin/cygpath -u ${quote(directory)})"` : quote(directory);
  // The unbound default entry is Bash, whose directory can precede the CI
  // Python on PATH. Select the probed bootstrap for this observed call only.
  return `PATH=${bin}:"$PATH" python -m venv ${prefix}`;
}

export async function startBackgroundWriter(cwd, signal, venvDir = join(cwd, '.venv')) {
  const marker = join(venvDir, 'background-partial');
  const writer = "const fs=require('node:fs'),marker=process.argv[1],heartbeat=marker+'-heartbeat';let ticks=0;const writeHeartbeat=value=>{const temp=heartbeat+'.tmp';fs.writeFileSync(temp,value);try{fs.renameSync(temp,heartbeat)}catch{fs.writeFileSync(heartbeat,value);fs.rmSync(temp,{force:true})}};writeHeartbeat('0');fs.writeFileSync(marker,'partial');const timer=setInterval(()=>{ticks+=1;writeHeartbeat(String(ticks))},100);setTimeout(()=>clearInterval(timer),90_000)";
  const child = spawn(process.execPath, ['-e', writer, marker], {
    // Unix retains the owner's process group. On Windows, detached skips
    // libuv's own kill-on-parent-exit child Job but still inherits Rust's Job.
    cwd, stdio: 'ignore', detached: process.platform === 'win32', windowsHide: true,
  });
  let failure;
  child.once('error', error => { failure = error; });
  child.once('exit', (code, signal) => { failure = new Error(`Background fixture exited early (${code ?? signal})`); });
  // Release Node's event-loop reference, not its process group/Job membership.
  child.unref();
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (failure) throw failure;
      const partial = await readFile(marker, 'utf8').catch(error => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (partial === 'partial' && child.pid) return child.pid;
      await new Promise(completed => setTimeout(completed, 25));
    }
    throw new Error('Background fixture did not confirm its partial write');
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
}

export default function (pi) {
  pi.registerTool({
    name: 'native_background_writer', label: 'Native background writer',
    description: 'Acceptance-only writer in the owning Pi process group or Job.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_id, _params, signal) {
      const cwd = process.cwd();
      // Managed state lives under {state}; HOME points at {state}/.agent-home (or
      // {workspace}/.agent-home for a workspace-bound launch), so its parent
      // names the same venv the launcher selected.
      const home = process.env.HOME ?? process.env.USERPROFILE;
      const pid = await startBackgroundWriter(cwd, signal, join(home, '..', '.venv'));
      return { content: [{ type: 'text', text: `BACKGROUND_STARTED ${pid}` }], details: { pid } };
    },
  });
}
