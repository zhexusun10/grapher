import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { actualPath, foldPath, hostPath, isCaseInsensitive, mapPhysicalPath, msysHostInput, pathStartsWith, pathWithin, setMsysHostAliases, toHostInput } from './path-identity.mjs';

// Explicit tool adaptation, not an operating-system mount namespace.

let cygpath;
const msysPaths = new Map();

function trustedGit() {
  return process.env.GRAPHER_TRUSTED_GIT || 'git';
}

function gitCygpath() {
  // Prefer the protected trusted Git binding over a business PATH shim.
  const candidates = [];
  const trusted = process.env.GRAPHER_TRUSTED_GIT;
  if (trusted) {
    const install = resolve(trusted, '../..');
    candidates.push(resolve(install, 'usr/bin/cygpath.exe'), resolve(install, '../../usr/bin/cygpath.exe'));
  }
  const known = candidates.find(candidate => existsSync(candidate));
  if (known) return known;
  try {
    const execPath = execFileSync(trustedGit(), ['--exec-path'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim();
    candidates.push(resolve(execPath, '../../../usr/bin/cygpath.exe'));
  } catch {
    // Fall through to the drive-letter spelling; no replacement shell starts.
  }
  return candidates.find(candidate => existsSync(candidate)) ?? null;
}

function driveFallback(value) {
  return value.replace(/^([A-Za-z]):\//, (_, drive) => `/${drive.toLowerCase()}/`);
}

function prefetchMsysPaths(values) {
  if (process.platform !== 'win32') return;
  // A semicolon is Git's path-list separator; never put such a value in the
  // one-shot batch, even if the output split count happens to look valid.
  const pending = [...new Set(values)].filter(value =>
    !msysPaths.has(value) && !value.includes(';'));
  if (!pending.length) return;
  for (const value of pending) msysPaths.set(value, driveFallback(value));
  if (cygpath === undefined) cygpath = gitCygpath();
  if (!cygpath) return;
  try {
    const output = execFileSync(cygpath, ['-u', '-p', pending.join(';')],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim();
    const converted = output.split(':');
    if (converted.length === pending.length) {
      pending.forEach((value, index) => msysPaths.set(value, converted[index]));
    } else {
      // Let the per-value converter retry rather than caching a partial batch.
      for (const value of pending) msysPaths.delete(value);
    }
  } catch {
    // Keep the drive-letter fallback; no replacement shell is started.
  }
}

function msysPath(value) {
  if (msysPaths.has(value)) return msysPaths.get(value);
  // Git Bash may expose mounts such as /tmp, not just /c/.... Use its path
  // converter without starting a replacement shell or changing Pi commands.
  if (cygpath === undefined) cygpath = gitCygpath();
  let result = driveFallback(value);
  if (cygpath) {
    try { result = execFileSync(cygpath, ['-u', value], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim(); }
    catch { /* Keep the ordinary drive spelling when Git has no converter. */ }
  }
  msysPaths.set(value, result);
  return result;
}

// A per-agent namespace. Never create a shared /workspace symlink: concurrent
// agents must map the same visible path to different checkouts.
function shellWords(text) {
  const words = [];
  for (let i = 0; i < text.length;) {
    if (/\s/.test(text[i]) || ';&|()<>'.includes(text[i])) { i++; continue; }
    const start = i;
    let value = '', quote = null, literal = true, windowsPath = false;
    for (; i < text.length; i++) {
      const c = text[i];
      if (!quote && (/\s/.test(c) || ';&|()<>'.includes(c))) break;
      if (c === '\\' && quote !== "'") {
        const next = text[i + 1];
        // Windows accepts native backslash paths in command spellings. Keep
        // them literal after a drive/UNC prefix instead of applying POSIX
        // escape removal, which would make the token look like a relative name.
        if (process.platform === 'win32'
            && (windowsPath || /[A-Za-z]:$/.test(value)
              || (value === '' && next === '\\' && text[i + 2] !== undefined))) {
          windowsPath = true;
          value += c;
          continue;
        }
        // POSIX double quotes only treat backslash as an escape before these.
        if (quote === '"' && next !== undefined && !/[$`"\\\n]/.test(next)) { value += c; continue; }
        if (next !== undefined) { value += text[++i]; continue; }
      }
      if (c === "'" || c === '"') {
        if (!quote) { quote = c; continue; }
        if (quote === c) { quote = null; continue; }
      }
      if (quote !== "'" && (c === '$' || c === '`')) literal = false;
      value += c;
    }
    words.push({ start, end: i, value, literal: literal && !quote });
  }
  return words;
}
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const regexEscape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const VISIBLE_ROOT = '\u0000GRAPHER_PATH_ROOT\u0000';

function unicodeVariants(value) {
  if (process.platform !== 'darwin') return [value];
  return [...new Set([value, value.normalize('NFD'), value.normalize('NFC')])];
}

export function visibleWindowsRoots(text) {
  if (!text.includes(VISIBLE_ROOT)) return text;
  let result = '', index = 0;
  while (index < text.length) {
    const marker = text.indexOf(VISIBLE_ROOT, index);
    if (marker < 0) { result += text.slice(index); break; }
    result += text.slice(index, marker) + '.';
    index = marker + VISIBLE_ROOT.length;
    while (index < text.length) {
      const character = text[index];
      // Windows treats duplicate/mixed separators as one separator; JSON
      // escapes a single separator as a pair. Collapse the whole run.
      if (character === '\\' || character === '/') {
        index++;
        while (text[index] === '\\' || text[index] === '/') index++;
        result += '/';
        continue;
      }
      if (/[\s"'`<>?:;,&|()\[\]{}]/.test(character) || character === '\0') break;
      result += character;
      index++;
    }
  }
  return result;
}

function remoteOrFileUrlBefore(text, at) {
  // Do not split a URL host/path because it happens to contain a local source
  // path spelling. Known file URLs are translated before the scanner starts.
  const before = text.slice(Math.max(0, at - 4096), at);
  return /[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]*$/i.test(before)
    // ssh/scp/rsync style host:/path is remote even without a URL scheme.
    || /(?:^|[\s"'`(])(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9_.-]+:$/.test(before);
}

function heredocRanges(text) {
  const ranges = [];
  let offset = 0;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
    const match = /(?:^|[\s;&|()])<<-?\s*(['"]?)([A-Za-z0-9_]+)\1/.exec(clean);
    if (!match || clean.includes('<<<')) { offset += line.length + 1; continue; }
    const delimiter = match[2];
    const stripTabs = /<<-/.test(match[0]);
    let endLine = index + 1;
    for (; endLine < lines.length; endLine++) {
      const raw = stripTabs ? lines[endLine].replace(/^\t+/, '') : lines[endLine];
      const candidate = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (candidate === delimiter) break;
    }
    if (endLine >= lines.length) { offset += line.length + 1; continue; }
    const start = offset + line.length + 1;
    let end = start;
    for (let cursor = index + 1; cursor < endLine; cursor++) end += lines[cursor].length + 1;
    ranges.push({ start, end });
    offset = end + lines[endLine].length + 1;
    index = endLine;
  }
  return ranges;
}

function insideRanges(ranges, at) {
  return ranges.find(range => at >= range.start && at < range.end);
}

export function createWorkspacePaths(directory, originalRoot = directory, sourceAlias = originalRoot, extraWorkspaces = []) {
  // Rust canonicalize() emits extended Windows paths. Node and Git Bash also
  // expose normal drive paths and /c/... spellings of the same directory.
  const root = hostPath(realpathSync(hostPath(directory)));
  // The source can be inaccessible under macOS/Linux isolation; never stat it.
  const base = hostPath(resolve(originalRoot));
  const WORKSPACE_PATH = base;
  const caseInsensitive = isCaseInsensitive(root);
  const variants = value => {
    const source = unicodeVariants(hostPath(value));
    if (process.platform !== 'win32') return source;
    return source.flatMap(native => {
      const slash = native.replaceAll('\\', '/');
      const extended = native.startsWith('\\\\') ? `\\\\?\\UNC\\${native.slice(2)}` : `\\\\?\\${native}`;
      const drive = slash.replace(/^([A-Za-z]):\//, (_, letter) => `/${letter.toLowerCase()}/`);
      const cygdrive = slash.replace(/^([A-Za-z]):\//, (_, letter) => `/cygdrive/${letter.toLowerCase()}/`);
      // Shell quoting and JSON can double separators; Windows collapses them
      // to the same path, so recognize those spellings before adaptation.
      const doubled = native.replaceAll('\\', '\\\\');
      const doubledSlash = slash.replaceAll('/', '//');
      return [native, slash, extended, extended.replaceAll('\\', '/'), drive, cygdrive,
        doubled, doubledSlash, msysPath(slash)];
    });
  };
  const allWorkspaces = [...new Set([
    resolve(directory), root,
    ...extraWorkspaces.map(workspace => resolve(workspace)),
  ])];
  const projectRoots = [...new Set([base, resolve(sourceAlias)])].sort((a, b) => b.length - a.length);
  const tempHostSlash = process.platform === 'win32' ? hostPath(tmpdir()).replaceAll('\\', '/') : '';
  const msysRoots = process.platform === 'win32'
    ? [...new Set([...allWorkspaces, ...projectRoots, tempHostSlash]
        .filter(Boolean)
        .map(value => hostPath(value).replaceAll('\\', '/')))]
    : [];
  if (process.platform === 'win32') prefetchMsysPaths(msysRoots);
  // Map known Git Bash spellings back to their host roots before passing a path
  // to the shared mapper. Treating /tmp as C:\tmp would risk a false match;
  // only roots we actually converted through Git's cygpath are eligible. The
  // same registry is used by workspace-tools for read/write/edit input.
  const msysHostAliases = msysRoots
    .map(slash => [msysPath(slash), slash])
    .filter(([msys, host]) => msys && msys !== host)
    .sort(([a], [b]) => b.length - a.length);
  setMsysHostAliases(msysHostAliases);
  // Project roots are stable for this execution; resolve their Windows actual
  // spelling once instead of running realpath for every absolute command word.
  const actualProjectRoots = process.platform === 'win32'
    ? projectRoots.map(root => actualPath(resolve(root)))
    : null;
  const aliases = [...new Set(allWorkspaces.flatMap(variants))].sort((a, b) => b.length - a.length);
  const projects = [...new Set(projectRoots.flatMap(variants))].sort((a, b) => b.length - a.length);
  const boundary = c => c === undefined || /[\s\\/"'`<>:;,&|()\[\]{}]/.test(c);
  function replaceable(text, at, length) {
    const after = at + length;
    const end = boundary(text[after]) || (text[after] === '.' && (text[after + 1] === undefined || /\s/.test(text[after + 1])));
    return (at === 0 || boundary(text[at - 1]) || text[at - 1] === '=' || text[at - 1] === '\\')
      && (end || text.slice(after, after + 3).toLowerCase() === '%2f' || text.slice(after, after + 2) === '\\/');
  }
  const spellings = [
    { plain: true, encode: value => value },
    { plain: true, encode: value => JSON.stringify(value).slice(1, -1) },
    { plain: true, encode: value => JSON.stringify(value).slice(1, -1).replace(/[\u007f-\uffff]/g, character =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`) },
    { plain: true, encode: value => value.replaceAll('/', '\\/') },
    { plain: true, encode: value => value.replaceAll('\\', '/') },
    { plain: true, encode: value => value.replaceAll('\\', '\\\\') },
    { plain: true, encode: value => value.replace(/[^a-zA-Z0-9_./\\-]/g, character => `\\${character}`) },
    { plain: true, encode: value => value.replaceAll("'", "'\\''") },
    { plain: false, encode: value => pathToFileURL(value).href },
    { plain: false, encode: value => encodeURI(value) },
    { plain: false, encode: value => encodeURIComponent(value) },
  ];
  // Plain filesystem paths are presented relative to the project root. Keep
  // structured URI encodings valid; do not turn file URLs into file://./... .
  const replacements = [...new Map(aliases.flatMap(alias => spellings.map(spelling => [
    spelling.encode(alias), spelling.plain ? (process.platform === 'win32' ? VISIBLE_ROOT : '.') : spelling.encode(base),
  ])).reverse()).entries()].sort(([a], [b]) => b.length - a.length);
  const pathPrefix = (value, prefix) => pathStartsWith(value, prefix, caseInsensitive);
  const commandPrefixes = projects;
  const commandRoot = process.platform === 'win32' ? root.replaceAll('\\', '/') : root;
  const commandIndex = new Map();
  for (const prefix of commandPrefixes) {
    const matcher = { prefix, length: prefix.length, folded: foldPath(prefix, caseInsensitive) };
    const first = foldPath(prefix.slice(0, 1), caseInsensitive);
    const matches = commandIndex.get(first) ?? [];
    matches.push(matcher);
    commandIndex.set(first, matches);
  }
  // Replace original input only, longest spelling first. Reprocessing a newly
  // normalized URI can corrupt it (especially when source cwd == workspace),
  // making the visible namespace differ between source and private turns.
  const visibleReplacements = new Map(replacements);
  const visibleLookup = new Map([...visibleReplacements].map(([alias, replacement]) =>
    [foldPath(alias, caseInsensitive), replacement]));
  const visiblePattern = new RegExp(replacements.map(([alias]) => regexEscape(alias)).join('|'),
    caseInsensitive ? 'gi' : 'g');
  const visible = text => {
    if (typeof text !== 'string') return text;
    const mapped = text.replace(visiblePattern,
      (alias, at) => !replaceable(text, at, alias.length) ? alias
        : visibleReplacements.get(alias) ?? visibleLookup.get(foldPath(alias, caseInsensitive)) ?? alias);
    return process.platform === 'win32' ? visibleWindowsRoots(mapped) : mapped;
  };
  const physical = value => {
    if (typeof value !== 'string') return value;
    // Git Bash mounts such as /tmp are not convertible by toHostInput() alone.
    // Convert only known roots, then use canonical roots so a real C:\tmp
    // path cannot be mistaken for the MSYS /tmp mount.
    const host = msysHostInput(value);
    const mapped = mapPhysicalPath(host, root, projectRoots, caseInsensitive);
    if (mapped === host && host !== value
        && !pathWithin(host, root, caseInsensitive)
        && !projectRoots.some(candidate => pathWithin(host, candidate, caseInsensitive))) {
      return value;
    }
    return mapped;
  };
  function findPrefixAt(text, at) {
    const character = text[at];
    // ASCII fast path: avoid normalizing/casefolding every scanned character.
    const first = character !== undefined && character.charCodeAt(0) < 128
      ? process.platform === 'win32'
        ? character.replace('/', '\\').toLowerCase()
        : caseInsensitive ? character.toLowerCase() : character
      : foldPath(character ?? '', caseInsensitive);
    const matches = commandIndex.get(first);
    if (!matches) return undefined;
    // Exact spelling is the common case; folded comparison is the fallback.
    for (const matcher of matches) {
      if (text.startsWith(matcher.prefix, at)) return matcher;
    }
    for (const matcher of matches) {
      if (foldPath(text.slice(at, at + matcher.length), caseInsensitive) === matcher.folded) {
        return matcher;
      }
    }
    return undefined;
  }

  function mapFileUrls(text) {
    for (const project of [...new Set([base, resolve(sourceAlias)].map(hostPath))]) {
      for (const spelling of unicodeVariants(project)) {
        let from;
        try { from = pathToFileURL(spelling).href; } catch { continue; }
        let to;
        try { to = pathToFileURL(commandRoot).href; } catch { continue; }
        if (from === to) continue;
        // Do not turn file:///project-other into file:///workspace-other.
        const boundary = '(?=$|[/\\\\?#"\'`\\s<>),;])';
        text = text.replace(new RegExp(regexEscape(from) + boundary, caseInsensitive ? 'gi' : 'g'), () => to);
      }
    }
    return text;
  }
  function mapCommand(text) {
    // A quoted sh -c argument is parsed again by the child shell. Translate at
    // that level first, then quote the entire script for the outer shell.
    text = mapFileUrls(text);
    const words = shellWords(text);
    const replacements = [];
    const foldedPrefixes = commandPrefixes.map(prefix => foldPath(prefix, caseInsensitive));
    for (let i = 0; i < words.length; i++) {
      if (!words[i].literal || !/^(?:.*[\\/])?(?:sh|bash|zsh|dash)(?:\.exe)?$/.test(words[i].value)) continue;
      for (let j = i + 1; j < words.length && /^-[a-zA-Z]+$/.test(words[j].value); j++) {
        if (!words[j].value.includes('c')) continue;
        const script = words[j + 1];
        const foldedScript = script ? foldPath(script.value, caseInsensitive) : '';
        if (script?.literal && foldedPrefixes.some(prefix => foldedScript.includes(prefix))) {
          replacements.push({ ...script, replacement: shellQuote(mapCommand(script.value)) });
          i = j + 1;
        }
        break;
      }
    }
    for (const item of replacements.reverse()) text = text.slice(0, item.start) + item.replacement + text.slice(item.end);
    // Recompute after nested-script replacements changed the text length.
    const heredocs = heredocRanges(text);
    // Preserve shell quoting when the actual checkout contains spaces, quotes or
    // expansion characters. Only translate literal workspace paths, not names
    // such as /workspace-other.
    let result = '', quote = null;
    const parentheses = [];
    for (let i = 0; i < text.length; i++) {
      const heredoc = insideRanges(heredocs, i);
      if (heredoc) {
        result += text.slice(i, heredoc.end);
        i = heredoc.end - 1;
        continue;
      }
      const c = text[i];
      const source = findPrefixAt(text, i);
      if (source && (i === 0 || boundary(text[i - 1]) || text[i - 1] === '=')
          && boundary(text[i + source.length]) && !remoteOrFileUrlBefore(text, i)) {
        // Do not rewrite a token that contains . or .. segments in the scanner.
        // Literal path words are handled by command() above; globs with dot
        // segments are safer left untouched than rewritten relative to a
        // possibly different workspace-relative external directory.
        let tokenEnd = i;
        while (tokenEnd < text.length && !/[\s"'`<>|;&()]/.test(text[tokenEnd])) tokenEnd++;
        const token = text.slice(i, tokenEnd);
        if (/(^|[\\/])\.{1,2}([\\/]|$)/.test(token)) {
          // Do not guess a workspace-relative spelling for a dotted token that
          // the word mapper could not resolve. Surface the residual inference
          // instead of leaving a source path silently unadapted.
          if (process.env.GRAPHER_PATH_DIAGNOSTICS !== '0') {
            console.error(`[grapher-path] source-like token left unadapted because it contains . or ..: ${token}`);
          }
          result += token;
          i = tokenEnd - 1;
          continue;
        }
        const shellPath = commandRoot;
        result += quote === "'" ? shellPath.replaceAll("'", "'\\''") : quote === '"' ? shellPath.replace(/[\\$`"]/g, '\\$&') : shellQuote(shellPath);
        i += source.length - 1;
        continue;
      }
      if (c === '\\' && quote !== "'") { result += text.slice(i, i + 2); i++; continue; }
      // $(...) has its own shell quoting context even inside double quotes.
      if (quote !== "'" && c === '$' && text[i + 1] === '(') {
        parentheses.push(quote); quote = null; result += '$('; i++; continue;
      }
      if (!quote && c === '(') { parentheses.push(null); result += c; continue; }
      if (!quote && c === ')' && parentheses.length) {
        quote = parentheses.pop(); result += c; continue;
      }
      if (c === "'" || c === '"') { if (quote === c) quote = null; else if (!quote) quote = c; }
      result += c;
    }
    return result;
  }
  function command(text) {
    text = mapFileUrls(text);
    // Preserve literal shell arguments with escaped spaces/quotes in the source
    // prefix. Only re-quote complete literal path/assignment tokens; never eval.
    const heredocs = heredocRanges(text);
    const edits = [];
    for (const word of shellWords(text)) {
      if (!word.literal || insideRanges(heredocs, word.start)
          || text.slice(word.start, word.end).includes('\n')) continue;
      const assignment = word.value.match(/^([A-Za-z_][A-Za-z_0-9]*=|--[A-Za-z_][A-Za-z_0-9-]*=)(.*)$/s);
      const attached = assignment ? undefined : word.value.match(/^(-[A-Za-z])(.*)$/s);
      const prefix = (assignment?.[1] ?? attached?.[1]) ?? '';
      const value = (assignment?.[2] ?? attached?.[2]) ?? word.value;
      const project = projects.find(project => pathPrefix(value, project));
      const host = toHostInput(msysHostInput(value));
      if (!project && (process.platform !== 'win32' || !isAbsolute(host))) continue;
      // Unquoted globs must retain glob semantics; the scanner below handles them.
      if (/[*?\[\]{}]/.test(value)) continue;
      let resolved = value;
      let mappedRoot;
      if (isAbsolute(host)) {
        resolved = process.platform === 'win32' ? actualPath(host) : resolve(host);
        mappedRoot = (actualProjectRoots ?? projectRoots.map(candidate => resolve(candidate)))
          .find(candidate => pathPrefix(resolved, candidate));
      }
      if (!project && !mappedRoot) continue;
      // A resolved path outside every project root is external. Do not fall
      // back to rewriting its source-looking prefix (for example source/../data),
      // which could point at a different directory after mapping.
      if (!mappedRoot && isAbsolute(host)) continue;
      const foldedValue = foldPath(mappedRoot ? resolved : value, caseInsensitive);
      const foldedProject = foldPath(mappedRoot ?? project, caseInsensitive);
      let suffix;
      if (mappedRoot) {
        const relativeSuffix = relative(mappedRoot, resolved).replaceAll('\\', '/');
        suffix = relativeSuffix === '..' || relativeSuffix.startsWith('../')
          ? foldedValue.slice(foldedProject.length).replaceAll('\\', '/')
          : relativeSuffix && !relativeSuffix.startsWith('/') ? `/${relativeSuffix}` : relativeSuffix;
      } else {
        suffix = foldedValue.slice(foldedProject.length).replaceAll('\\', '/');
      }
      edits.push({ ...word, replacement: prefix + shellQuote(commandRoot + suffix) });
    }
    for (const edit of edits.reverse()) text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
    return mapCommand(text);
  }
  function view(value) {
    if (typeof value === 'string') return visible(value);
    if (Array.isArray(value)) return value.map(view);
    if (value && typeof value === 'object') {
      // Opaque provider signatures and image bytes must survive context mapping.
      if (value.type === 'image' || value.type === 'thinking' || value.type === 'redactedThinking') return value;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [visible(key),
        ['signature', 'textSignature', 'thinkingSignature', 'id', 'toolCallId'].includes(key) ? item : view(item),
      ]));
    }
    return value;
  }
  return { root, visible, physical, command, view, WORKSPACE_PATH };
}
