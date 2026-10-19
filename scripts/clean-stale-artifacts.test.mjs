import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanStaleArtifacts, parseActiveArtifacts } from './clean-stale-artifacts.mjs';

test('parseActiveArtifacts resolves current active dependencies for grapher', async () => {
  const result = await parseActiveArtifacts();
  assert.ok(result.activeFiles.size > 0, 'Should find active files in Cargo output');
  assert.ok(result.activeBuildDirs.size > 0, 'Should find active build dirs');
  assert.equal(result.profile, 'debug');
});

test('cleanStaleArtifacts dryRun reports zero stale items on a clean build target', async () => {
  const logs = [];
  const result = await cleanStaleArtifacts({
    dryRun: true,
    log: msg => logs.push(msg),
  });

  assert.equal(result.dryRun, true);
  assert.ok(result.activeCount > 0, 'Should protect active dependencies');
  assert.equal(result.staleCount, 0, 'No stale artifacts should be reported on clean target');
  assert.equal(result.reclaimedBytes, 0);
});
