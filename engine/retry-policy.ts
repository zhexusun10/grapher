import { SettingsManager } from './pi-compat.ts';

let configured = false;

// Enforce the host's reconnect budget without modifying upstream or persisted
// user settings. Cap exponential backoff at its base to keep every wait at 2s.
export function configureExecutionRetries() {
  if (configured) return;
  configured = true;
  SettingsManager.prototype.getRetryEnabled = () => true;
  SettingsManager.prototype.getRetrySettings = () => ({
    enabled: true,
    maxRetries: 5,
    baseDelayMs: 2000,
    maxAgentDelayMs: 2000,
  });
  const providerSettings = SettingsManager.prototype.getProviderRetrySettings;
  SettingsManager.prototype.getProviderRetrySettings = function () {
    // One retry owner: provider-internal retries must not multiply the budget.
    return { ...providerSettings.call(this), maxRetries: 0 };
  };
}
