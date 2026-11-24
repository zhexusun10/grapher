import assert from "node:assert/strict";
import test from "node:test";
import {
  cacheFileChangeSummary,
  getCachedFileChangeSummary,
  invalidateFileChangeSummaryCache,
} from "../src/services/fileChanges.ts";

import { fixtureFileChangeSummary } from "./fixtures/current-api.mjs";

test("file-change summary cache is run-scoped and invalidated per Run or globally", () => {
  const first = fixtureFileChangeSummary([{ path: "src/a.ts", status: "added", additions: 1, deletions: 0 }]);
  const second = fixtureFileChangeSummary([{ path: "src/b.ts", status: "modified", additions: 2, deletions: 1 }]);
  cacheFileChangeSummary("cache-test:scope-a", "cache-test", first);
  cacheFileChangeSummary("other-run:scope-a", "other-run", second);
  assert.equal(getCachedFileChangeSummary("cache-test:scope-a"), first);

  invalidateFileChangeSummaryCache("cache-test");
  assert.equal(getCachedFileChangeSummary("cache-test:scope-a"), undefined);
  assert.equal(getCachedFileChangeSummary("other-run:scope-a"), second);

  cacheFileChangeSummary("cache-test:scope-b", "cache-test", first);
  invalidateFileChangeSummaryCache();
  assert.equal(getCachedFileChangeSummary("cache-test:scope-b"), undefined);
  assert.equal(getCachedFileChangeSummary("other-run:scope-a"), undefined);
});
