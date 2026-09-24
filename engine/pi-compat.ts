// Grapher's only source-level Pi binding. Keep upstream paths and API
// assumptions here so a Pi upgrade can be reviewed and contract-tested in one place.
// Use Pi's public SDK exports for the production tool/provider surface.
export {
  ModelRuntime,
  SettingsManager,
  createBashToolDefinition,
  createLocalBashOperations,
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
  createLsToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
} from '../pi/packages/coding-agent/src/index.ts';
export type { ExtensionAPI, BashOperations } from '../pi/packages/coding-agent/src/index.ts';

// Pi does not currently export its path normalization or source CLI entrypoint
// through the SDK. These two private touchpoints remain explicit until it does.
export { resolveToCwd } from '../pi/packages/coding-agent/src/core/tools/path-utils.ts';
export async function runPiCli() {
  await import('../pi/packages/coding-agent/src/cli.ts');
}
