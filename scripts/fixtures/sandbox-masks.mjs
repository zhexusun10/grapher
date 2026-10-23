// Acceptance-test helper for the Linux private-execution mask trees. Not
// production code and not part of the environment policy fixtures.
import { chmodSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Remove the private-execution mask trees under a native-runtime parent before a
 * recursive delete of the test root. A mask clears the read bit so that listing
 * a protected path reports a permission error instead of a silent empty
 * directory, and a generic recursive delete cannot list such a directory. This
 * mirrors the backend's own `remove_dir_all_masked` reaping, which is how the
 * same trees are reclaimed when an engine cache is reaped.
 */
export function removeSandboxMasks(runtimeParent) {
  let caches;
  try { caches = readdirSync(runtimeParent, { withFileTypes: true }); } catch { return; }
  for (const cache of caches) {
    if (!cache.isDirectory()) continue;
    const directory = join(runtimeParent, cache.name);
    let entries;
    try { entries = readdirSync(directory); } catch { continue; }
    for (const name of entries) {
      if (!name.startsWith('.grapher-masks-')) continue;
      const staging = join(directory, name);
      // Restore owner access to the mask children (each is an unreadable bind
      // source, or execute-only when it carries an allowed exception).
      try { for (const child of readdirSync(staging)) chmodSync(join(staging, child), 0o700); } catch {}
      rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}
