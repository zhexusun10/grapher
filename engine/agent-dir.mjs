import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { toHostInput } from './path-identity.mjs';
import { mkdirSync, symlinkSync, copyFileSync, accessSync, statSync, readFileSync, writeFileSync, constants } from 'node:fs';

const EMPTY_MODELS_CONFIG = '{\n  "providers": {}\n}\n';

export const KNOWN_PROVIDER_ENV_VARS = {
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL'],
  openai: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL'],
  groq: ['GROQ_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  'github-copilot': ['COPILOT_GITHUB_TOKEN'],
  cohere: ['COHERE_API_KEY', 'CO_API_KEY'],
  perplexity: ['PERPLEXITY_API_KEY'],
  xai: ['XAI_API_KEY'],
};

export function applyDisabledProviders(env = process.env) {
  const dir = env.PI_CODING_AGENT_DIR || join(homedir(), '.grapher', 'pi-agent');
  let disabled = [];
  try {
    disabled = JSON.parse(readFileSync(join(dir, 'disabled-providers.json'), 'utf8'));
  } catch {}
  env.PYTHONDONTWRITEBYTECODE = '1';
  if (Array.isArray(disabled)) {
    for (const p of disabled) {
      if (typeof p === 'string' && Object.hasOwn(KNOWN_PROVIDER_ENV_VARS, p)) {
        for (const v of KNOWN_PROVIDER_ENV_VARS[p]) delete env[v];
      }
    }
  }
}

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
      try { copyFileSync(source, join(bin, name), constants.COPYFILE_EXCL); } catch {}
      continue;
    }
    try { symlinkSync(source, join(bin, name)); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

export function ensureDefaultModelsFile(directory) {
  const path = join(directory, 'models.json');
  try {
    writeFileSync(path, EMPTY_MODELS_CONFIG, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

// Provider/Auth, local login and native executions use the same dedicated
// upstream-owned configuration directory.
export function configureAgentDir() {
  let directory = toHostInput(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.grapher', 'pi-agent'));
  if (directory === '~' || /^~[\\/]/.test(directory)) directory = homedir() + directory.slice(1);
  directory = resolve(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  ensureDefaultModelsFile(directory);
  process.env.PI_CODING_AGENT_DIR = directory;

  reuseManagedTools(directory, join(homedir(), '.pi', 'agent'));
  return directory;
}
