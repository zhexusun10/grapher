import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

// Provider/Auth, local login and native executions use the same dedicated
// upstream-owned configuration directory. HOME itself stays the host HOME.
export function configureAgentDir() {
  let directory = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.grapher', 'pi-agent');
  if (directory === '~' || directory.startsWith('~/')) directory = homedir() + directory.slice(1);
  directory = resolve(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  process.env.PI_CODING_AGENT_DIR = directory;
  return directory;
}
