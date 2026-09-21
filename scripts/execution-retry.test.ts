import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SettingsManager } from '../pi/packages/coding-agent/src/core/settings-manager.ts';
import { retryDelayMs, isRetryableAssistantError } from '../pi/packages/ai/src/utils/retry.ts';
import { configureExecutionRetries } from '../engine/retry-policy.ts';

test('execution reconnects five times with fixed two second waits', () => {
  configureExecutionRetries();
  const settings = SettingsManager.inMemory({
    retry: { enabled: false, maxRetries: 20, baseDelayMs: 10000, provider: { maxRetries: 10 } },
  });
  const policy = settings.getRetrySettings();
  assert.equal(settings.getRetryEnabled(), true);
  assert.equal(policy.maxRetries, 5);
  assert.deepEqual(Array.from({ length: policy.maxRetries }, (_, i) => retryDelayMs(policy, i + 1)),
    [2000, 2000, 2000, 2000, 2000]);
  assert.equal(settings.getProviderRetrySettings().maxRetries, 0);
  for (const errorMessage of ['network connection lost', 'fetch failed', 'socket hang up', 'websocket closed']) {
    assert.equal(isRetryableAssistantError({ stopReason: 'error', errorMessage } as any), true);
  }
});
