// Cross-platform filesystem identity for model-facing path adaptation.
// This module compares real paths, converts Node/Git Bash spellings and maps
// source-project paths to the current private workspace. It is not a sandbox.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
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
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = resolve(toHostInput(left));
  const b = resolve(toHostInput(right));
  if (a === b) return true;
  const identity = statusIdentity(a, b);
  if (identity !== undefined) return identity;
  const actualA = actualPath(a);
  const actualB = actualPath(b);
  if (actualA === actualB) return true;
  const insensitive = process.platform === 'win32'
    || isCaseInsensitive(dirname(a)) || isCaseInsensitive(dirname(b))
    || isCaseInsensitive(actualA) || isCaseInsensitive(actualB);
  return foldPath(actualA, insensitive) === foldPath(actualB, insensitive);
}

/** Stable key for de-duplicating resources on case/Unicode-insensitive volumes. */
export function pathKey(value) {
  const path = actualPath(value);
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
 * Resolve a path to its actual host spelling, keeping missing leaf components
 * under the deepest existing ancestor. This mirrors Rust `actual_path()` and
 * covers Windows 8.3 names, junctions, drive aliases and macOS case spelling.
 */
export function actualPath(value) {
  if (typeof value !== 'string') return value;
  const original = resolve(toHostInput(value));
  const missing = [];
  let candidate = original;
  while (true) {
    try {
      const actual = hostPath(realpathSync.native(hostPath(candidate)));
      return missing.length ? resolve(actual, ...missing.reverse()) : actual;
    } catch {}
    const parent = dirname(candidate);
    if (parent === candidate) return original;
    missing.push(basename(candidate));
    candidate = parent;
  }
}

/** Whether a path is inside a root after host spelling and case folding. */
export function pathWithin(value, root, caseInsensitive = isCaseInsensitive(root)) {
  if (typeof value !== 'string' || typeof root !== 'string') return false;
  const foldedValue = foldPath(resolve(toHostInput(value)), caseInsensitive);
  const foldedRoot = foldPath(resolve(toHostInput(root)), caseInsensitive).replace(/[\\/]+$/, '');
  return foldedValue === foldedRoot
    || foldedValue.startsWith(foldedRoot + '/')
    || foldedValue.startsWith(foldedRoot + '\\');
}

/**
 * Map a source-project path to the current workspace. Exact spelling wins;
 * on case/normalization-insensitive volumes a folded comparison is used as a
 * fallback. Internal paths use host spelling; non-project paths are returned
 * unchanged in the caller's spelling (external host paths).
 */
export function mapPhysicalPath(value, workspace, roots, caseInsensitive = isCaseInsensitive(workspace)) {
  if (typeof value !== 'string') return value;
  const path = resolve(toHostInput(value));
  // Paths already in the target workspace need no source-prefix work. This
  // keeps file-tool calls on already-mapped paths cheap on Windows.
  const workspacePath = resolve(workspace);
  if (inside(relative(workspacePath, path))) return path;
  for (const root of roots) {
    const suffix = relative(resolve(root), path);
    if (inside(suffix)) return resolve(workspace, suffix);
  }
  // Resolve the actual host spelling as a best-effort fallback. The workspace
  // and the requested path are local, so this covers symlinks and missing
  // leaves. Source roots are probed only on Windows; elsewhere the source can
  // be inaccessible inside the execution sandbox and must not be required.
  const actual = actualPath(path);
  if (inside(relative(actualPath(workspacePath), actual))) return actual;
  if (process.platform === 'win32') {
    for (const root of roots) {
      // MSYS roots are matched lexically above; resolving them as Win32 paths
      // would turn /c/... into C:\c\... and could match an unrelated folder.
      // Keep forward-slash UNC/extended roots available for realpath.
      if (root.startsWith('/') && !root.startsWith('//')) continue;
      const suffix = relative(actualPath(resolve(root)), actual);
      if (inside(suffix)) return resolve(workspace, suffix);
    }
  }
  const foldedPath = foldPath(path, caseInsensitive);
  for (const root of roots) {
    const suffix = relative(foldPath(resolve(root), caseInsensitive), foldedPath);
    if (inside(suffix)) return resolve(workspace, suffix);
  }
  return value;
}

/** Compare two directories by filesystem identity, then by normalized spelling. */
export function sameDirectory(left, right) {
  if (!left || !right) return false;
  const identity = statusIdentity(left, right);
  if (identity !== undefined) return identity;
  return samePath(left, right);
}
