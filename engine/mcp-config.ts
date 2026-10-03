// Pi loads one agent directory. Grapher has two: merge their global definitions
// before applying Pi 1.0.1 project overrides, using upstream validation throughout.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CONFIG_DIR_NAME, loadMcpConfig, mcpNamespace, validateMcpServerConfig,
  type LoadedMcpConfig, type McpServerEntry } from './pi-compat.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function loadGrapherMcpConfig(options: {
  globalDir: string; agentDir: string; cwd: string; projectTrusted: boolean;
}): LoadedMcpConfig {
  const servers = new Map<string, McpServerEntry>();
  const errors: string[] = [];
  let autoEnableCodemode: boolean | undefined;
  const add = (entry: McpServerEntry) => {
    const clash = [...servers.keys()].find(name => name !== entry.name && mcpNamespace(name) === mcpNamespace(entry.name));
    if (clash) errors.push(`${entry.source}: server "${entry.name}" conflicts with "${clash}"`);
    else servers.set(entry.name, entry);
  };
  const directories = [...new Set([options.globalDir, options.agentDir].map(directory => resolve(directory)))];
  for (const agentDir of directories) {
    const loaded = loadMcpConfig({ agentDir, cwd: options.cwd, projectTrusted: false });
    errors.push(...loaded.errors);
    if (loaded.autoEnableCodemode !== undefined) autoEnableCodemode = loaded.autoEnableCodemode;
    for (const entry of loaded.servers) add(entry);
  }
  const projectConfig = options.projectTrusted ? join(options.cwd, CONFIG_DIR_NAME, 'mcp.json') : undefined;
  if (projectConfig && existsSync(projectConfig)) {
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(projectConfig, 'utf8')); }
    catch (error) { errors.push(`${projectConfig}: ${error instanceof Error ? error.message : String(error)}`); }
    if (parsed !== undefined) {
      if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
        errors.push(`${projectConfig}: expected an object with an "mcpServers" object`);
      } else {
        if (typeof parsed.autoEnableCodemode === 'boolean') autoEnableCodemode = parsed.autoEnableCodemode;
        else if (parsed.autoEnableCodemode !== undefined) errors.push(`${projectConfig}: autoEnableCodemode must be a boolean`);
        for (const [name, value] of Object.entries(parsed.mcpServers ?? {})) {
          const override = isRecord(value) && value.command === undefined && value.url === undefined && value.type === undefined;
          const base = servers.get(name);
          if (override && !base) {
            errors.push(`${projectConfig}: server "${name}" needs "command" or "url", or a global server to override`);
            continue;
          }
          if (override && Object.keys(value).some(key => !['enabled', 'exposure', 'toolExposure'].includes(key))) {
            errors.push(`${projectConfig}: server "${name}": an override can only set enabled, exposure, toolExposure`);
            continue;
          }
          const config = validateMcpServerConfig(name, override ? { ...base!.config, ...value } : value);
          if (typeof config === 'string') {
            errors.push(`${projectConfig}: ${config}`);
          } else if (!override && 'url' in config && config.auth) {
            errors.push(`${projectConfig}: server "${name}": auth is only allowed in the global mcp.json`);
          } else {
            add(override ? { ...base!, config, override: projectConfig } : { name, config, source: projectConfig, scope: 'project' });
          }
        }
      }
    }
  }
  return {
    servers: [...servers.values()], errors,
    ...(autoEnableCodemode === undefined ? {} : { autoEnableCodemode }),
    ...(projectConfig ? { projectConfig } : {}),
  };
}
