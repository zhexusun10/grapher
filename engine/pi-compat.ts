// Grapher's only source-level Pi binding. Keep upstream paths and API
// assumptions here so a Pi upgrade can be reviewed and contract-tested in one place.
// Use Pi's public SDK exports for the production tool/provider surface.
export {
  ModelRuntime,
  SettingsManager,
  DefaultPackageManager,
  createMcpExtension,
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

// Private path, MCP-config and CLI-setup touchpoints remain centralized here.
export { loadMcpConfig } from '../pi/packages/coding-agent/src/extensions/mcp/config.ts';
export type { LoadedMcpConfig, McpServerEntry } from '../pi/packages/coding-agent/src/index.ts';
export { mcpNamespace, validateMcpServerConfig } from '../pi/packages/coding-agent/src/core/mcp-servers.ts';
export { CONFIG_DIR_NAME } from '../pi/packages/coding-agent/src/config.ts';
export { resolveToCwd } from '../pi/packages/coding-agent/src/core/tools/path-utils.ts';
import type { MainOptions } from '../pi/packages/coding-agent/src/index.ts';
export type { InlineExtension } from '../pi/packages/coding-agent/src/index.ts';
let preparedCli: Promise<[typeof import('../pi/packages/coding-agent/src/cli/setup.ts'), typeof import('../pi/packages/coding-agent/src/index.ts')]> | undefined;
// Import/code preparation only: no resources, extensions, sessions or model calls.
export function preparePiCli() {
  return preparedCli ??= Promise.all([
    import('../pi/packages/coding-agent/src/cli/setup.ts'),
    import('../pi/packages/coding-agent/src/index.ts'),
  ]);
}
export async function runPiCli(args: string[], options: MainOptions = {}) {
  const [{ setupCli }, { main }] = await preparePiCli();
  setupCli();
  await main(args, options);
}
