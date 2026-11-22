// Read missing search keys from the user's global Pi store. Keep all writes
// in the extension's current agent directory and never copy keys into env vars.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { toHostInput } from './path-identity.mjs';

export const TOP_DEDICATED_SEARCH_PROVIDERS = [
  ['parallel', 'PARALLEL_API_KEY'],
  ['keenable', 'KEENABLE_API_KEY'],
  ['exa', 'EXA_API_KEY'],
  ['perplexity', 'PERPLEXITY_API_KEY'],
];
const ALL_DEDICATED_PROVIDERS = ['deepseek', 'exa', 'keenable', 'parallel', 'perplexity'];

function isValidApiKey(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[^\x21-\x7e]/.test(value);
}

function readSavedKeyFile(path, provider) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    if (parsed.version !== 1 || !parsed.keys || typeof parsed.keys !== 'object' || Array.isArray(parsed.keys)) return undefined;
    // Match upstream decodeStore: any invalid provider entry invalidates the store.
    for (const name of ALL_DEDICATED_PROVIDERS) {
      const entry = parsed.keys[name];
      if (entry !== undefined && !isValidApiKey(entry)) return undefined;
    }
    const value = parsed.keys[provider];
    return isValidApiKey(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function readSavedApisSettings(agentDir) {
  try {
    const path = process.env.PI_BETTER_WEB_SEARCH_SETTINGS || join(agentDir, 'better-web-search-settings.json');
    const parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== 1) return undefined;
    if (!parsed.apis || typeof parsed.apis !== 'object' || Array.isArray(parsed.apis)) return undefined;
    for (const name of ALL_DEDICATED_PROVIDERS) {
      if (parsed.apis[name] !== undefined && typeof parsed.apis[name] !== 'boolean') return undefined;
    }
    if (parsed.apis.keenableKeyRequired !== undefined && typeof parsed.apis.keenableKeyRequired !== 'boolean') return undefined;
    return parsed.apis;
  } catch {
    return undefined;
  }
}

export function isKeenableDisabledInDir(agentDir) {
  return readSavedApisSettings(agentDir)?.keenable === false;
}

export function readGrapherKeenablePublic(agentDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(agentDir, 'extensions.json'), 'utf8'));
    return parsed?.webSearch?.keenablePublic === true;
  } catch {
    return false;
  }
}

export function hasConfiguredDedicatedSearchApi(credentials, apis) {
  return TOP_DEDICATED_SEARCH_PROVIDERS.some(([provider, env]) =>
    apis?.[provider] !== false && Boolean(credentials.savedApiKey(provider) || process.env[env]?.trim()),
  );
}

export function hasConfiguredDedicatedSearchApiInDir(agentDir, globalDir) {
  const apis = readSavedApisSettings(agentDir);
  const explicitAuth = process.env.PI_BETTER_WEB_SEARCH_AUTH?.trim();
  const ownAuth = explicitAuth || join(agentDir, 'better-web-search-auth.json');
  const globalAuth = !explicitAuth && process.env.GRAPHER_ISOLATED_PI_SEARCH !== '1'
    ? resolve(globalDir, 'better-web-search-auth.json')
    : undefined;
  const inheritGlobal = globalAuth && globalAuth !== resolve(ownAuth);
  return TOP_DEDICATED_SEARCH_PROVIDERS.some(([provider, env]) => {
    if (apis?.[provider] === false) return false;
    if (process.env[env]?.trim()) return true;
    if (readSavedKeyFile(ownAuth, provider)) return true;
    if (inheritGlobal && readSavedKeyFile(globalAuth, provider)) return true;
    return false;
  });
}

export function withInheritedSearchCredentials(upstream) {
  const inheritedApiKey = provider => {
    if (process.env.PI_BETTER_WEB_SEARCH_AUTH?.trim() || process.env.GRAPHER_ISOLATED_PI_SEARCH === '1') return undefined;
    let directory = toHostInput(process.env.GRAPHER_GLOBAL_PI_AGENT_DIR || join(homedir(), '.pi', 'agent'));
    if (directory === '~' || /^~[\\/]/.test(directory)) directory = homedir() + directory.slice(1);
    const source = resolve(directory, 'better-web-search-auth.json');
    if (source === resolve(upstream.getCredentialsPath())) return undefined;
    const previous = process.env.PI_BETTER_WEB_SEARCH_AUTH;
    // savedApiKey is synchronous: restore the path before any other IPC job
    // can run. Validation and file parsing stay owned by the pinned extension.
    process.env.PI_BETTER_WEB_SEARCH_AUTH = source;
    try { return upstream.savedApiKey(provider); }
    finally {
      if (previous === undefined) delete process.env.PI_BETTER_WEB_SEARCH_AUTH;
      else process.env.PI_BETTER_WEB_SEARCH_AUTH = previous;
    }
  };
  return {
    ...upstream,
    savedApiKey: provider => upstream.savedApiKey(provider) || inheritedApiKey(provider),
  };
}

// Enable Keenable's public endpoint when the user explicitly opted in while
// mounting web search, and automatically stop once Parallel, Keenable, Exa or
// Perplexity has an API key configured.
export function withGrapherSearchPreferences(upstream, credentials, getAgentDir) {
  const syntheticApis = new WeakSet();
  return {
    ...upstream,
    readProviderPreferences() {
      const base = upstream.readProviderPreferences();
      if (base.apis?.keenable !== undefined) return base;
      if (!readGrapherKeenablePublic(getAgentDir())) return base;
      if (hasConfiguredDedicatedSearchApi(credentials, base.apis)) return base;
      const apis = { ...base.apis, keenable: true };
      syntheticApis.add(apis);
      return { ...base, apis };
    },
    writeProviderPreferences(preferences) {
      if (preferences?.apis?.keenable === true && !preferences.apis.keenableKeyRequired) {
        const base = upstream.readProviderPreferences();
        const wasSynthetic = base.apis?.keenable === undefined
          && readGrapherKeenablePublic(getAgentDir())
          && !hasConfiguredDedicatedSearchApi(credentials, base.apis);
        if (wasSynthetic) {
          const otherApisChanged = Object.keys({ ...base.apis, ...preferences.apis })
            .some(key => key !== 'keenable' && preferences.apis?.[key] !== base.apis?.[key]);
          if (syntheticApis.has(preferences.apis) || otherApisChanged) {
            const { keenable: _synthetic, ...rest } = preferences.apis;
            return upstream.writeProviderPreferences({
              ...preferences,
              apis: Object.keys(rest).length ? rest : undefined,
            });
          }
        }
      }
      return upstream.writeProviderPreferences(preferences);
    },
  };
}
