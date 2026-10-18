// Cross-platform filesystem identity for model-facing path adaptation.
// This module compares real paths, converts Node/Git Bash spellings and maps
// source-project paths to the current private workspace. It is not a sandbox.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const caseCache = new Map();

/** Strip Rust's extended Windows prefix for Node/Git Bash consumers. */
export function hostPath(value) {
  if (process.platform !== 'win32') return value;
  if (value.startsWith('\\\\?\\UNC\\')) return `\\\\${value.slice(8)}`;
  if (value.startsWith('\\\\?\\')) return value.slice(4);
  // Node consumers also accept the forward-slash extended spelling.
  if (value.startsWith('//?/UNC/')) return `\\\\${value.slice(8).replaceAll('/', '\\')}`;
  if (value.startsWith('//?/')) return value.slice(4).replaceAll('/', '\\');
  return value;
}

/**
 * Whether the volume containing an existing directory folds letter case.
 * macOS can use either APFS mode; Windows is always case-insensitive.
 * The probe compares the status of the same path spelled with swapped case.
 */
export function isCaseInsensitive(directory) {
  if (process.platform === 'win32') return true;
  if (process.platform !== 'darwin') return false;
  const key = resolve(hostPath(directory));
  if (caseCache.has(key)) return caseCache.get(key);
  let result = false;
  try {
    const original = statSync(key, { bigint: true });
    const swapped = key.replace(/[A-Za-z]/g, character =>
      character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase());
    if (swapped !== key && existsSync(swapped)) {
      const other = statSync(swapped, { bigint: true });
      result = original.dev === other.dev && original.ino === other.ino;
    }
  } catch {
    // A missing probe directory is not proof either way. Callers fall back to
    // exact matching, which is the conservative behavior.
  }
  caseCache.set(key, result);
  return result;
}

export function foldPath(value, caseInsensitive) {
  let text = process.platform === 'darwin' ? value.normalize('NFD') : value;
  if (process.platform === 'win32') text = text.replaceAll('/', '\\');
  return caseInsensitive ? text.toLowerCase() : text;
}

/** Prefix check that follows the same case/Unicode rules as path mapping. */
export function pathStartsWith(value, prefix, caseInsensitive) {
  const foldedValue = foldPath(value, caseInsensitive);
  const foldedPrefix = foldPath(prefix, caseInsensitive);
  return foldedValue === foldedPrefix
    || foldedValue.startsWith(foldedPrefix + '/')
    || foldedValue.startsWith(foldedPrefix + '\\');
}

function inside(suffix) {
  return !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`);
}

function statusIdentity(left, right) {
  if (process.platform === 'win32') return undefined;
  try {
    const a = statSync(left, { bigint: true });
    const b = statSync(right, { bigint: true });
    if (a.dev === b.dev && a.ino === b.ino) return true;
  } catch {}
  return undefined;
}

/** Compare two existing or prospective paths without trusting spelling. */
export function samePath(left, right) {
  if (left === right) return true;
  const a = resolve(hostPath(left));
  const b = resolve(hostPath(right));
  if (a === b) return true;
  const identity = statusIdentity(a, b);
  if (identity !== undefined) return identity;
  if (process.platform === 'win32') {
    try {
      return realpathSync.native(hostPath(a)).toLowerCase() === realpathSync.native(hostPath(b)).toLowerCase();
    } catch {}
  } else {
    try {
      if (realpathSync(a) === realpathSync(b)) return true;
    } catch {}
  }
  const insensitive = isCaseInsensitive(dirname(a)) || isCaseInsensitive(dirname(b));
  return foldPath(a, insensitive) === foldPath(b, insensitive);
}

/** Stable key for de-duplicating resources on case/Unicode-insensitive volumes. */
export function pathKey(value) {
  let path = resolve(hostPath(value));
  try { path = realpathSync(path); } catch {}
  const insensitive = process.platform === 'win32' || isCaseInsensitive(dirname(path)) || isCaseInsensitive(path);
  return foldPath(hostPath(path), insensitive).replace(new RegExp(`\\${sep}+$`), '');
}

/** Convert a file URL or Git Bash /c/... spelling to a Node host path. */
export function toHostInput(value) {
  if (typeof value !== 'string') return value;
  let text = value;
  if (text.startsWith('file:')) {
    try { text = fileURLToPath(text); } catch { return value; }
  }
  if (process.platform === 'win32') {
    if (/^\/cygdrive\/[A-Za-z]\//.test(text)) {
      text = `${text[10].toUpperCase()}:${text.slice(11)}`;
    } else if (/^\/[A-Za-z]\//.test(text)) {
      text = `${text[1].toUpperCase()}:${text.slice(2)}`;
    }
  }
  return hostPath(text);
}

/**
 * Map a source-project path to the current workspace. Exact spelling wins;
 * on case/normalization-insensitive volumes a folded comparison is used as a
 * fallback. Non-project paths are returned unchanged (external host paths).
 */
export function mapPhysicalPath(value, workspace, roots, caseInsensitive = isCaseInsensitive(workspace)) {
  if (typeof value !== 'string') return value;
  const path = resolve(hostPath(value));
  // Paths already in the target workspace need no source-prefix work. This
  // keeps file-tool calls on already-mapped paths cheap on Windows.
  const workspacePath = resolve(workspace);
  if (inside(relative(workspacePath, path))) return path;
  for (const root of roots) {
    const suffix = relative(resolve(root), path);
    if (inside(suffix)) return resolve(workspace, suffix);
  }
  if (process.platform === 'win32') {
    // Expand 8.3 names and junction aliases before falling back to casefold.
    try {
      const realPath = realpathSync.native(hostPath(path));
      for (const root of roots) {
        let realRoot;
        try { realRoot = realpathSync.native(hostPath(resolve(root))); } catch { continue; }
        const suffix = relative(realRoot, realPath);
        if (inside(suffix)) return resolve(workspace, suffix);
      }
    } catch {}
  }
  const foldedPath = foldPath(path, caseInsensitive);
  for (const root of roots) {
    const suffix = relative(foldPath(resolve(root), caseInsensitive), foldedPath);
    if (inside(suffix)) return resolve(workspace, suffix);
  }
  return path;
}

/** Compare two directories by filesystem identity, then by normalized spelling. */
export function sameDirectory(left, right) {
  if (!left || !right) return false;
  const identity = statusIdentity(left, right);
  if (identity !== undefined) return identity;
  return samePath(left, right);
}
