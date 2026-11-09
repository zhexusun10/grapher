import { chmodSync, copyFileSync, constants, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

let temporaryDirectory;
let temporarySequence = 0;
const snapshots = new Map();
function temporaryModelsPath(content) {
  const digest = createHash('sha256').update(content).digest('hex');
  const existing = snapshots.get(digest);
  if (existing && existsSync(existing)) return existing;
  if (!temporaryDirectory) {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'grapher-models-'));
    process.once('exit', () => { try { rmSync(temporaryDirectory, { recursive: true, force: true }); } catch {} });
  }
  const path = join(temporaryDirectory, `models-${++temporarySequence}.json`);
  writeFileSync(path, content, { mode: 0o600, flag: 'wx' });
  snapshots.set(digest, path);
  return path;
}

// Provider fields and model overrides merge recursively. Model definitions are
// keyed by id, with a complete Pi model replacing a matching Grapher model.
function merge(base, preferred, key = '') {
  if (key === 'models' && Array.isArray(base) && Array.isArray(preferred)) {
    const ids = new Set(preferred.map(model => model?.id).filter(id => typeof id === 'string'));
    return [...base.filter(model => !ids.has(model?.id)), ...preferred];
  }
  if (base && preferred && typeof base === 'object' && typeof preferred === 'object'
      && !Array.isArray(base) && !Array.isArray(preferred)) {
    const result = { ...base };
    for (const [name, value] of Object.entries(preferred)) {
      Object.defineProperty(result, name, { value: merge(base[name], value, name), enumerable: true, configurable: true, writable: true });
    }
    return result;
  }
  return preferred;
}

/** Prepare a private, process-local model overlay. The source files are never modified. */
export async function prepareModelOverlay(agentDir, parse, options = {}) {
  if (process.env.GRAPHER_ISOLATED_PI_MODELS === '1') return undefined;
  const source = options.source ?? process.env.GRAPHER_UPSTREAM_PI_MODELS ?? join(homedir(), '.pi', 'agent', 'models.json');
  const target = join(agentDir, 'models.json');
  let sourceContent, targetContent;
  try { sourceContent = readFileSync(source, 'utf8'); }
  catch (error) {
    // Preserve Pi's normal file-aware error and built-in provider catalog.
    return error.code === 'ENOENT' ? undefined : source;
  }
  try { targetContent = readFileSync(target, 'utf8'); }
  catch (error) { return error.code === 'ENOENT' ? source : target; }
  let sourceReal, targetReal;
  try { sourceReal = realpathSync(source); } catch { return source; }
  try { targetReal = realpathSync(target); } catch { return target; }
  if (sourceReal === targetReal) return undefined;

  // On malformed JSON let Pi report its usual warning and continue serving
  // built-ins. Never let a valid file mask errors in the other file.
  let local, upstream;
  try { local = parse(targetContent); } catch { return target; }
  try { upstream = parse(sourceContent); } catch { return source; }
  // Pi must validate both layers separately: merging first could hide an
  // invalid field or a missing required property behind the other layer.
  if (options.validate) {
    if (!(await options.validate(target))) return target;
    if (!(await options.validate(source))) return source;
    // Avoid merging bytes different from those Pi validated during concurrent edits.
    try { if (readFileSync(target, 'utf8') !== targetContent) return target; } catch { return target; }
    try { if (readFileSync(source, 'utf8') !== sourceContent) return source; } catch { return source; }
  }

  // Keep a one-time copy of the old Windows snapshot before introducing an
  // overlay. Never replace an existing backup or rewrite user configuration.
  const backup = join(agentDir, 'models.json.grapher-backup');
  try {
    copyFileSync(target, backup, constants.COPYFILE_EXCL);
    chmodSync(backup, 0o600);
  } catch (error) { if (error.code !== 'EEXIST') throw error; }

  return temporaryModelsPath(JSON.stringify(merge(local, upstream)));
}

/** Retarget only Pi's default agent models file, not explicitly supplied files. */
export async function overlayRuntimeOptions(options, agentDir, parse, validate) {
  const defaultPath = join(agentDir, 'models.json');
  if (options.modelsPath === null || (options.modelsPath && resolve(options.modelsPath) !== resolve(defaultPath))) return options;
  const modelsPath = await prepareModelOverlay(agentDir, parse, { validate });
  return modelsPath ? { ...options, modelsPath, modelsStorePath: options.modelsStorePath ?? join(agentDir, 'models-store.json') } : options;
}
