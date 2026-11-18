// Cross-platform filesystem identity for model-facing path adaptation.
// This module compares real paths, converts Node/Git Bash spellings and maps
// source-project paths to the current private workspace. It is not a sandbox.
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
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

function swapAsciiCase(value) {
  return value.replace(/[A-Za-z]/g, character =>
    character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase());
}

function lstatSafe(target) {
  try {
    return lstatSync(target, { bigint: true });
  } catch {
    return undefined;
  }
}

/**
 * Whether the volume containing an existing directory folds letter case.
 * macOS can use either APFS mode; Windows is always case-insensitive.
 * Probes stay on the target volume's device so mount points never borrow the
 * parent filesystem's case behavior.
 */
export function isCaseInsensitive(directory) {
  if (process.platform === 'win32') return true;
  if (process.platform !== 'darwin' || typeof directory !== 'string' || !directory) return false;
  let cursor = resolve(toHostInput(directory));
  while (true) {
    if (lstatSafe(cursor)) {
      let existing = cursor;
      try {
        existing = hostPath(realpathSync.native(existing));
      } catch {}
      let dirStats = lstatSafe(existing);
      let dir = existing;
      if (!dirStats || !dirStats.isDirectory()) {
        dir = dirname(existing);
        try {
          dir = hostPath(realpathSync.native(dir));
        } catch {}
        dirStats = lstatSafe(dir);
      }
      if (!dirStats || !dirStats.isDirectory()) return false;
      const devKey = dirStats.dev.toString();
      if (caseCache.has(devKey)) return caseCache.get(devKey);

      const targetDev = dirStats.dev;
      let probeDir = dir;
      let mountRoot = dir;
      let resolvedValue;
      while (true) {
        const parent = dirname(probeDir);
        const parentStats = parent !== probeDir ? lstatSafe(parent) : undefined;
        const name = basename(probeDir);
        if (parentStats && parentStats.dev === targetDev && /[A-Za-z]/.test(name)) {
          const entryStats = lstatSafe(probeDir);
          const swappedStats = lstatSafe(join(parent, swapAsciiCase(name)));
          resolvedValue = Boolean(
            entryStats && swappedStats && swappedStats.dev === entryStats.dev && swappedStats.ino === entryStats.ino,
          );
          break;
        }
        try {
          let chosen;
          for (const entry of readdirSync(probeDir)) {
            if (!/[A-Za-z]/.test(entry)) continue;
            const entryStats = lstatSafe(join(probeDir, entry));
            if (!entryStats || entryStats.dev !== targetDev) continue;
            if (entryStats.isDirectory()) {
              chosen = [entry, entryStats];
              break;
            }
            // Regular/link hardlinks can share an inode across distinct ASCII-case names;
            // only single-link non-directories prove same-entry case folding.
            if (!chosen && entryStats.nlink === 1n) {
              chosen = [entry, entryStats];
            }
          }
          if (chosen) {
            const [entry, entryStats] = chosen;
            const swappedStats = lstatSafe(join(probeDir, swapAsciiCase(entry)));
            resolvedValue = Boolean(
              swappedStats && swappedStats.dev === entryStats.dev && swappedStats.ino === entryStats.ino,
            );
            break;
          }
        } catch {}
        if (!parentStats || parentStats.dev !== targetDev || parent === probeDir) {
          mountRoot = probeDir;
          break;
        }
        probeDir = parent;
      }
      if (resolvedValue === undefined) {
        let hasCliTools = false;
        try {
          // Only invoke /usr/bin/python3 when Xcode/CommandLineTools is present;
          // on a clean macOS machine the stub binary otherwise triggers an install UI dialog.
          execFileSync('/usr/bin/xcode-select', ['-p'], { stdio: 'ignore', timeout: 1000 });
          hasCliTools = true;
        } catch {}
        if (hasCliTools) {
          try {
            execFileSync(
              '/usr/bin/python3',
              [
                '-c',
                'import ctypes, sys; r = ctypes.CDLL(None).pathconf(sys.argv[1].encode(), 11); sys.exit(0 if r == 0 else 1 if r == 1 else 2)',
                mountRoot,
              ],
              { stdio: 'ignore', timeout: 2000 },
            );
            resolvedValue = true;
          } catch (error) {
            if (error?.status === 1) resolvedValue = false;
          }
        }
      }
      if (resolvedValue !== undefined) {
        caseCache.set(devKey, resolvedValue);
        return resolvedValue;
      }
      return false;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

export function resolveSourceCaseInsensitive(workspaceCaseInsensitive, explicit) {
  if (typeof explicit === 'boolean') return explicit;
  if (process.env.GRAPHER_SOURCE_CASE_INSENSITIVE === '1') return true;
  if (process.env.GRAPHER_SOURCE_CASE_INSENSITIVE === '0') return false;
  return workspaceCaseInsensitive;
}

export function relativePreservingCase(root, target, caseInsensitive) {
  const resolvedRoot = resolve(toHostInput(root));
  const resolvedTarget = resolve(toHostInput(target));
  const rootParsed = parse(resolvedRoot);
  const targetParsed = parse(resolvedTarget);
  if (foldPath(rootParsed.root, caseInsensitive) !== foldPath(targetParsed.root, caseInsensitive)) {
    return undefined;
  }
  const splitPattern = process.platform === 'win32' ? /[\\/]+/ : /\/+/;
  const rootParts = resolvedRoot.slice(rootParsed.root.length).split(splitPattern).filter(Boolean);
  const targetParts = resolvedTarget.slice(targetParsed.root.length).split(splitPattern).filter(Boolean);
  if (targetParts.length < rootParts.length) return undefined;
  for (let i = 0; i < rootParts.length; i++) {
    if (foldPath(targetParts[i], caseInsensitive) !== foldPath(rootParts[i], caseInsensitive)) {
      return undefined;
    }
  }
  return targetParts.slice(rootParts.length).join(sep);
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
    return a.dev === b.dev && a.ino === b.ino;
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
    || isCaseInsensitive(actualA) || isCaseInsensitive(actualB);
  return foldPath(actualA, insensitive) === foldPath(actualB, insensitive);
}

/** Stable key for de-duplicating resources on case/Unicode-insensitive volumes. */
export function pathKey(value) {
  const path = actualPath(value);
  const insensitive = process.platform === 'win32' || isCaseInsensitive(path);
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

// Git Bash mounts such as /tmp are not derivable from the drive spelling.
// workspace-paths registers the exact aliases discovered through cygpath; the
// mapper can then use the same conversion for file-tool read/write/edit input.
const msysHostAliases = [];
export function setMsysHostAliases(entries = []) {
  msysHostAliases.length = 0;
  const seen = new Set();
  for (const [msys, host] of entries) {
    if (typeof msys !== 'string' || typeof host !== 'string') continue;
    const from = msys.replaceAll('\\', '/');
    const to = host.replaceAll('\\', '/');
    if (!from.startsWith('/') || from.startsWith('//') || from === to || seen.has(from)) continue;
    seen.add(from);
    msysHostAliases.push([from, to]);
  }
  msysHostAliases.sort(([a], [b]) => b.length - a.length);
}

/** Convert a registered Git Bash mount to the host path for tool input. */
export function msysHostInput(value) {
  if (process.platform !== 'win32' || typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) {
    return value;
  }
  for (const [msys, host] of msysHostAliases) {
    if (value === msys || value.startsWith(`${msys}/`)) {
      return `${host}${value.slice(msys.length)}`;
    }
  }
  // Standalone file-tool mappers may not have created a workspace yet. Git
  // Bash's conventional /tmp is the host TEMP mount; cygpath aliases above
  // take precedence when a workspace has registered the exact spelling.
  if (value === '/tmp' || value.startsWith('/tmp/')) {
    const temp = process.env.TEMP || process.env.TMP;
    if (temp) return `${temp.replace(/[\\/]+$/, '').replaceAll('\\', '/')}${value.slice(4)}`;
  }
  return value;
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
export function mapPhysicalPath(
  value,
  workspace,
  roots,
  workspaceCaseInsensitive = isCaseInsensitive(workspace),
  sourceCaseInsensitive = workspaceCaseInsensitive,
) {
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
  const actualWorkspace = actualPath(workspacePath);
  if (inside(relative(actualWorkspace, actual))) return actual;
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
  const wsSuffix = relativePreservingCase(workspacePath, path, workspaceCaseInsensitive);
  if (wsSuffix !== undefined) return resolve(workspacePath, wsSuffix);
  if (actual !== path || actualWorkspace !== workspacePath) {
    const actualSuffix = relativePreservingCase(actualWorkspace, actual, workspaceCaseInsensitive);
    if (actualSuffix !== undefined) return resolve(actualWorkspace, actualSuffix);
  }
  for (const root of roots) {
    const suffix = relativePreservingCase(root, path, sourceCaseInsensitive);
    if (suffix !== undefined) return resolve(workspace, suffix);
  }
  return value;
}
