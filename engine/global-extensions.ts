// Discover resources without loading extension code or changing the user's Pi config.
import { readFileSync, existsSync, realpathSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultPackageManager, SettingsManager, createMcpExtension, type InlineExtension } from './pi-compat.ts';
import { loadGrapherMcpConfig } from './mcp-config.ts';

const builtins = ['llama.cpp', 'codemode', 'tool-search', 'mcp'];
export const trimId = 'npm:pi-trim';
export const bundledTrim = fileURLToPath(new URL('../node_modules/pi-trim/extensions/index.ts', import.meta.url));
export const globalAgentDir = () => {
  const path = process.env.GRAPHER_GLOBAL_PI_AGENT_DIR || join(homedir(), '.pi', 'agent');
  return resolve(path === '~' || path.startsWith('~/') ? homedir() + path.slice(1) : path);
};
const identity = (path: string) => {
  const value = existsSync(path) ? realpathSync(path) : resolve(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
};
function isTrim(resource: { path: string; metadata: { source: string; packageRoot?: string } }) {
  if (/^npm:pi-trim(?:@|$)/.test(resource.metadata.source) || identity(resource.path) === identity(bundledTrim)) return true;
  if (resource.metadata.packageRoot) {
    try { return JSON.parse(readFileSync(join(resource.metadata.packageRoot, 'package.json'), 'utf8')).name === 'pi-trim'; } catch {}
  }
  return false;
}
function extensionName(resource: { path: string; metadata: { source: string; packageRoot?: string } }) {
  if (resource.metadata.packageRoot) {
    try {
      const name = JSON.parse(readFileSync(join(resource.metadata.packageRoot, 'package.json'), 'utf8')).name;
      if (typeof name === 'string' && name) return name;
    } catch {}
  }
  return basename(resource.path);
}
function overrides(directory: string): Record<string, boolean> {
  const path = join(directory, 'extensions.json');
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, 'utf8')).overrides;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(v => typeof v !== 'boolean')) {
    throw new Error('Invalid Grapher extensions.json');
  }
  // Ignore obsolete selections from versions that allowed disabling pi-trim.
  delete value[trimId];
  return value;
}
async function resolveGlobal() {
  const agentDir = globalAgentDir();
  const path = join(agentDir, 'settings.json');
  const settingsManager = SettingsManager.inMemory(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}, { projectTrusted: false });
  const manager = new DefaultPackageManager({ cwd: agentDir, agentDir, settingsManager, builtinExtensions: builtins });
  // Settings must not install missing packages on the UI or agent startup path.
  return manager.resolve(async () => 'skip');
}
export interface PiExtension {
  id: string;
  name: string;
  source: string;
  path: string;
  enabled: boolean;
  bundled: boolean;
}
export async function extensionCatalog(directory: string) {
  const state = overrides(directory);
  const resources = await resolveGlobal();
  const extensions: PiExtension[] = [{ id: trimId, name: 'pi-trim', source: trimId, path: bundledTrim, enabled: true, bundled: true }];
  const seen = new Set([trimId]);
  for (const resource of resources.extensions) {
    if (resource.path.startsWith('builtin:') || isTrim(resource)) continue;
    const id = identity(resource.path);
    if (seen.has(id)) continue;
    seen.add(id);
    extensions.push({ id, name: extensionName(resource), source: resource.metadata.source,
      path: resource.path, enabled: state[id] ?? resource.enabled, bundled: false });
  }
  return { globalDirectory: globalAgentDir(), extensions };
}
export async function setExtensionEnabled(directory: string, id: string, enabled: boolean) {
  if (id === trimId) throw new Error('Bundled pi-trim is required and cannot be changed');
  const catalog = await extensionCatalog(directory);
  if (!catalog.extensions.some(extension => extension.id === id)) throw new Error('Unknown Pi extension');
  const state = overrides(directory);
  state[id] = enabled;
  const target = join(directory, 'extensions.json');
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ overrides: state }, null, 2), { mode: 0o600 });
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return extensionCatalog(directory);
}

export async function executionResources(args: string[], directory: string, role = process.env.GRAPHER_MODE) {
  const state = overrides(directory);
  const extensionFactories: InlineExtension[] = [];
  const extensions: string[] = [];
  const skills: string[] = [];
  const discoverExtensions = !args.includes('--no-extensions') && !args.includes('-ne');
  const discoverSkills = !args.includes('--no-skills') && !args.includes('-ns');
  const allowed = (role === 'planner' || role === 'node') && (discoverExtensions || discoverSkills);
  if (allowed) {
    const global = await resolveGlobal();
    const settingsManager = SettingsManager.create(process.cwd(), directory, { projectTrusted: args.includes('--approve') });
    const manager = new DefaultPackageManager({ cwd: process.cwd(), agentDir: directory, settingsManager, builtinExtensions: builtins });
    const local = await manager.resolve(async () => 'skip');
    const globalById = new Map(global.extensions.filter(r => !r.path.startsWith('builtin:') && !isTrim(r)).map(r => [identity(r.path), r]));
    const seenExtensions = new Set<string>();
    for (const resource of discoverExtensions ? [...local.extensions, ...global.extensions] : []) {
      if (isTrim(resource)) continue; // Always use the bundled, pinned pi-trim exactly once.
      const builtin = resource.path.startsWith('builtin:');
      const id = builtin ? resource.path : identity(resource.path);
      const original = builtin ? global.extensions.find(r => r.path === id) : globalById.get(id);
      const enabled = builtin
        ? (original?.enabled ?? true) && (local.extensions.find(r => r.path === id)?.enabled ?? true)
        : state[id] ?? original?.enabled ?? resource.enabled;
      if (!enabled || seenExtensions.has(id)) continue;
      seenExtensions.add(id);
      extensions.push(resource.path);
    }
    if (discoverSkills) {
      const seenSkills = new Set<string>();
      for (const resource of [...local.skills, ...global.skills]) {
        const id = identity(resource.path);
        if (resource.enabled && !seenSkills.has(id)) {
          seenSkills.add(id);
          skills.push(resource.path);
        }
      }
    }
    // Keep credentials in Grapher's dedicated agent directory; read global MCP
    // config fresh, then let dedicated/project entries win name collisions.
    if (extensions.includes('builtin:mcp')) {
      extensions.splice(extensions.indexOf('builtin:mcp'), 1);
      extensionFactories.push({ name: 'grapher-mcp', factory: createMcpExtension({
        loadConfig: ctx => loadGrapherMcpConfig({
          globalDir: globalAgentDir(), agentDir: directory, cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted(),
        }),
      }) });
    }
  }
  extensions.push(bundledTrim);
  extensions.push(fileURLToPath(new URL('./prompt-extension.ts', import.meta.url)));
  return {
    // Only explicit, selected resources reach Pi; no automatic second loading.
    args: [...args, '--no-extensions', '--no-skills', ...extensions.flatMap(path => ['--extension', path]), ...skills.flatMap(path => ['--skill', path])],
    extensionFactories,
  };
}
