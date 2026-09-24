import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync, existsSync, symlinkSync, copyFileSync, accessSync, statSync, constants } from 'node:fs';

// Reuse only Pi's known managed executables, not its configuration or plugins.
// No downloads on the planning critical path and no replacement of local tools.
export function reuseManagedTools(directory, upstreamDirectory) {
  for (const tool of ['rg', 'fd']) {
    const name = process.platform === 'win32' ? `${tool}.exe` : tool;
    const source = join(upstreamDirectory, 'bin', name);
    try {
      if (!statSync(source).isFile()) continue;
      accessSync(source, constants.X_OK);
    } catch { continue; }
    const bin = join(directory, 'bin');
    mkdirSync(bin, { recursive: true, mode: 0o700 });
    if (process.platform === 'win32') {
      try { copyFileSync(source, join(bin, name)); } catch {}
      continue;
    }
    try { symlinkSync(source, join(bin, name)); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

// Provider/Auth, local login and native executions use the same dedicated
// upstream-owned configuration directory. HOME itself stays the host HOME.
export function configureAgentDir() {
  let directory = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.grapher', 'pi-agent');
  if (directory === '~' || directory.startsWith('~/')) directory = homedir() + directory.slice(1);
  directory = resolve(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  process.env.PI_CODING_AGENT_DIR = directory;

  const targetModels = join(directory, 'models.json');
  const sourceModels = join(homedir(), '.pi', 'agent', 'models.json');
  if (!existsSync(targetModels) && existsSync(sourceModels)) {
    if (process.platform === 'win32') {
      try { copyFileSync(sourceModels, targetModels); } catch {}
    } else {
      try { symlinkSync(sourceModels, targetModels); } catch {}
    }
  }

  reuseManagedTools(directory, join(homedir(), '.pi', 'agent'));
  return directory;
}
