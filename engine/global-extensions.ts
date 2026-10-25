// Discover resources without loading extension code or changing the user's Pi config.
import { readFileSync, existsSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { isCaseInsensitive, pathKey, toHostInput } from './path-identity.mjs';
import { fileURLToPath } from 'node:url';
import { DefaultPackageManager, SettingsManager, createMcpExtension, type InlineExtension } from './pi-compat.ts';
import { loadGrapherMcpConfig } from './mcp-config.ts';
import workspacePolicy from './prompt-extension.ts';

// Native ESM reuses the already loaded Pi SDK. Passing this mandatory adapter
// through jiti would load its relative SDK dependency graph a second time.
// Import only code here: the factory captures task paths/role after binding.
export const workspacePolicyName = 'grapher-workspace-policy';

const builtins = ['llama.cpp', 'codemode', 'tool-search', 'mcp'];
export const trimId = 'npm:pi-trim';
export const bundledTrim = fileURLToPath(new URL('../node_modules/pi-trim/extensions/index.ts', import.meta.url));
export const continuityId = 'npm:pi-continuity';
export const bundledContinuity = fileURLToPath(new URL('../node_modules/pi-continuity/extensions/index.ts', import.meta.url));
export const webSearchId = 'npm:pi-better-web-search';
export const bundledWebSearch = fileURLToPath(new URL('../node_modules/pi-better-web-search/extensions/index.ts', import.meta.url));
// Bundled extensions are pinned project dependencies; only trim is mandatory.
const bundledExtensions = [
  { id: trimId, name: 'pi-trim', path: bundledTrim, required: true, defaultEnabled: true },
  { id: continuityId, name: 'pi-continuity', path: bundledContinuity, required: false, defaultEnabled: true },
  { id: webSearchId, name: 'pi-better-web-search', path: bundledWebSearch, required: false, defaultEnabled: false },
];
const bundledDefault = (id: string) => bundledExtensions.find(extension => extension.id === id)?.defaultEnabled ?? true;
export const globalAgentDir = () => {
  const path = toHostInput(process.env.GRAPHER_GLOBAL_PI_AGENT_DIR || join(homedir(), '.pi', 'agent'));
  return resolve(path === '~' || /^~[\\/]/.test(path) ? homedir() + path.slice(1) : path);
};
const identity = (path: string) => pathKey(path);
const keyCase = (value: string, path: string) =>
  isCaseInsensitive(dirname(path)) ? value.toLowerCase() : value;
function isBundled(resource: { path: string; metadata: { source: string; packageRoot?: string } }) {
  if (bundledExtensions.some(extension => resource.metadata.source === extension.id ||
    resource.metadata.source.startsWith(`${extension.id}@`) || identity(resource.path) === identity(extension.path))) return true;
  if (resource.metadata.packageRoot) {
    try {
      const name = JSON.parse(readFileSync(join(resource.metadata.packageRoot, 'package.json'), 'utf8')).name;
      return bundledExtensions.some(extension => extension.name === name);
    } catch {}
  }
  return false;
}
// Scoped packages must keep their full identity (including the directory name
// fallback) or @a/tools and @b/tools would shadow each other's skills.
function packageName(packageRoot: string | undefined): string | undefined {
  if (!packageRoot) return undefined;
  try {
    const name = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).name;
    if (typeof name === 'string' && name) return name;
  } catch {}
  const parent = basename(dirname(packageRoot));
  const base = basename(packageRoot);
  return parent.startsWith('@') ? `${parent}/${base}` : base;
}
function extensionName(resource: { path: string; metadata: { source: string; packageRoot?: string } }) {
  return packageName(resource.metadata.packageRoot) ?? basename(resource.path);
}
export function extensionPackageName(resource: { path: string; metadata: { source: string; packageRoot?: string } }): string | undefined {
  return packageName(resource.metadata.packageRoot);
}
export function resourceKey(resource: { path: string; metadata: { source: string; packageRoot?: string; baseDir?: string } }): string {
  if (resource.path.startsWith('builtin:')) return resource.path;
  if (resource.metadata.packageRoot) {
    const name = extensionName(resource);
    const subpath = relative(resource.metadata.packageRoot, resource.path).replace(/\\/g, '/');
    const key = `pkg:${name}:${subpath}`;
    return keyCase(key, resource.path);
  }
  if (resource.metadata.baseDir) {
    const subpath = relative(resource.metadata.baseDir, resource.path).replace(/\\/g, '/');
    const key = `file:${subpath}`;
    return keyCase(key, resource.path);
  }
  const key = `file:${basename(resource.path)}`;
  return keyCase(key, resource.path);
}
export function skillKey(resource: { path: string; metadata?: { packageRoot?: string; baseDir?: string } }): string {
  if (resource.metadata?.packageRoot) {
    const pkg = packageName(resource.metadata.packageRoot) ?? basename(resource.metadata.packageRoot);
    const rel = relative(resource.metadata.packageRoot, resource.path).replace(/\\/g, '/');
    const key = `pkg:${pkg}:${rel}`;
    return keyCase(key, resource.path);
  }
  if (resource.metadata?.baseDir) {
    const rel = relative(resource.metadata.baseDir, resource.path).replace(/\\/g, '/');
    const key = `file:${rel}`;
    return keyCase(key, resource.path);
  }
  const cleanPath = resource.path.replace(/[/\\]SKILL\.md$/i, '').replace(/[/\\]index\.[jt]s$/i, '');
  const key = `file:${basename(cleanPath)}`;
  return keyCase(key, resource.path);
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
  required: boolean;
}
export async function extensionCatalog(directory: string) {
  const state = overrides(directory);
  const resources = await resolveGlobal();
  const extensions: PiExtension[] = bundledExtensions.map(({ defaultEnabled, ...extension }) => ({ ...extension, source: extension.id,
    enabled: extension.required || (state[extension.id] ?? defaultEnabled), bundled: true }));
  const seen = new Set(extensions.map(extension => extension.id));
  for (const resource of resources.extensions) {
    if (resource.path.startsWith('builtin:') || isBundled(resource)) continue;
    const id = identity(resource.path);
    if (seen.has(id)) continue;
    seen.add(id);
    extensions.push({ id, name: extensionName(resource), source: resource.metadata.source,
      path: resource.path, enabled: state[id] ?? resource.enabled, bundled: false, required: false });
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
  const extensionFactories: InlineExtension[] = [{ name: workspacePolicyName, factory: workspacePolicy }];
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
    const globalById = new Map(global.extensions.filter(r => !r.path.startsWith('builtin:') && !isBundled(r)).map(r => [identity(r.path), r]));
    const globalByKey = new Map(global.extensions.filter(r => !r.path.startsWith('builtin:') && !isBundled(r)).map(r => [resourceKey(r), r]));
    const seenExtensions = new Set<string>();
    const seenKeys = new Set<string>();
    const localPackages = new Set<string>();
    const localKeys = new Set<string>();

    const normalizePkg = (pkg: string) => process.platform === 'win32' ? pkg.toLowerCase() : pkg;
    for (const resource of local.extensions) {
      if (isBundled(resource)) continue;
      const pkg = extensionPackageName(resource);
      if (pkg) localPackages.add(normalizePkg(pkg));
      localKeys.add(resourceKey(resource));
    }

    const candidateList = discoverExtensions
      ? [
          ...local.extensions.map(resource => ({ resource, isLocal: true })),
          ...global.extensions.map(resource => ({ resource, isLocal: false })),
        ]
      : [];

    for (const { resource, isLocal } of candidateList) {
      if (isBundled(resource)) continue; // Use only the selected bundled copies, never global/project duplicates.
      const builtin = resource.path.startsWith('builtin:');
      const id = builtin ? resource.path : identity(resource.path);
      const key = resourceKey(resource);
      const pkg = extensionPackageName(resource);
      const normalizedPkg = pkg ? normalizePkg(pkg) : undefined;

      if (!isLocal) {
        if (normalizedPkg && localPackages.has(normalizedPkg)) continue;
        if (localKeys.has(key) || seenKeys.has(key)) continue;
      }

      const original = builtin ? global.extensions.find(r => r.path === id) : (globalById.get(id) ?? globalByKey.get(key));
      const originalId = original ? identity(original.path) : undefined;
      const enabled = builtin
        ? (original?.enabled ?? true) && (local.extensions.find(r => r.path === id)?.enabled ?? true)
        : state[id] ?? (originalId ? state[originalId] : undefined) ?? original?.enabled ?? resource.enabled;

      if (!enabled || seenExtensions.has(id) || seenKeys.has(key)) continue;
      seenExtensions.add(id);
      seenKeys.add(key);
      extensions.push(resource.path);
    }
    if (discoverSkills) {
      const seenSkills = new Set<string>();
      const seenSkillKeys = new Set<string>();
      const localSkillKeys = new Set<string>();

      for (const resource of local.skills) {
        localSkillKeys.add(skillKey(resource));
      }

      const candidateSkills = [
        ...local.skills.map(resource => ({ resource, isLocal: true })),
        ...global.skills.map(resource => ({ resource, isLocal: false })),
      ];

      for (const { resource, isLocal } of candidateSkills) {
        const id = identity(resource.path);
        const key = skillKey(resource);

        if (!isLocal && localSkillKeys.has(key)) continue;
        if (resource.enabled && !seenSkills.has(id) && !seenSkillKeys.has(key)) {
          seenSkills.add(id);
          seenSkillKeys.add(key);
          skills.push(resource.path);
        }
      }
    }
    // Web search follows the normal extension opt-in and only augments roles
    // that already receive user extensions.
    if (discoverExtensions && (state[webSearchId] ?? bundledDefault(webSearchId))) {
      extensions.push(bundledWebSearch);
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
  const continuityAllowed = role === 'planner' || role === 'node' || role === 'merger';
  if (continuityAllowed && discoverExtensions && (state[continuityId] ?? bundledDefault(continuityId))) {
    extensions.push(bundledContinuity);
  }
  extensions.push(bundledTrim);
  return {
    // Only explicit, selected resources reach Pi; no automatic second loading.
    args: [...args, '--no-extensions', '--no-skills', ...extensions.flatMap(path => ['--extension', path]), ...skills.flatMap(path => ['--skill', path])],
    extensionFactories,
  };
}
