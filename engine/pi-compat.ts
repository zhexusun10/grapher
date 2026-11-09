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
} from '../pi/packages/coding-agent/src/index.ts';
export type { ExtensionAPI, BashOperations } from '../pi/packages/coding-agent/src/index.ts';

export { obj, opt, str } from '../pi/packages/schema/src/index.ts';
import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from '../pi/packages/ai/src/index.ts';

// This is the protocol vocabulary, not a list of levels every model supports.
const thinkingLevels: ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export function getModelThinkingCapabilities(model: Model<Api>) {
  const supported = getSupportedThinkingLevels(model);
  const fallbacks: Partial<Record<ModelThinkingLevel, ModelThinkingLevel>> = {};
  for (const level of thinkingLevels) {
    if (!supported.includes(level)) fallbacks[level] = clampThinkingLevel(model, level);
  }
  return { thinkingLevels: supported, thinkingLevelFallbacks: fallbacks };
}

// Private path, MCP-config and CLI-setup touchpoints remain centralized here.
export { loadMcpConfig } from '../pi/packages/coding-agent/src/extensions/mcp/config.ts';
export type { LoadedMcpConfig, McpServerEntry } from '../pi/packages/coding-agent/src/index.ts';
export { mcpNamespace, validateMcpServerConfig } from '../pi/packages/coding-agent/src/core/mcp-servers.ts';
export { CONFIG_DIR_NAME } from '../pi/packages/coding-agent/src/config.ts';
export { resolveToCwd } from '../pi/packages/coding-agent/src/core/tools/path-utils.ts';
import type { MainOptions } from '../pi/packages/coding-agent/src/index.ts';
import { ModelRuntime } from '../pi/packages/coding-agent/src/index.ts';
import { stripJsonComments } from '../pi/packages/coding-agent/src/utils/json.ts';
import { ModelConfig } from '../pi/packages/coding-agent/src/core/model-config.ts';
import { overlayRuntimeOptions } from './model-config-overlay.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const parseModels = (content: string) => JSON.parse(stripJsonComments(content.replace(/^\uFEFF/, '')));
export function modelRuntimeOptions(options: Parameters<typeof ModelRuntime.create>[0] = {}) {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.grapher', 'pi-agent');
  return overlayRuntimeOptions(options, agentDir, parseModels, async (path: string) => !(await ModelConfig.load(path)).getError());
}
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
  // Pi's CLI creates its own runtime. Retarget its default models path while
  // retaining the original auth and models-store locations.
  const create = ModelRuntime.create;
  ModelRuntime.create = async (runtimeOptions = {}) => create.call(ModelRuntime, await modelRuntimeOptions(runtimeOptions));
  try { await main(args, options); }
  finally { ModelRuntime.create = create; }
}
