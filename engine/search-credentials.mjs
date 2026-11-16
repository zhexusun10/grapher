// Read missing search keys from the user's global Pi store. Keep all writes
// in the extension's current agent directory and never copy keys into env vars.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { toHostInput } from './path-identity.mjs';

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
