import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

let cygpath;
const msysPaths = new Map();
function msysPath(value) {
  if (msysPaths.has(value)) return msysPaths.get(value);
  // Git Bash may expose mounts such as /tmp, not just /c/.... Use its path
  // converter without starting a replacement shell or changing Pi commands.
  if (cygpath === undefined) {
    try {
      const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim();
      cygpath = resolve(execPath, '../../../usr/bin/cygpath.exe');
    } catch { cygpath = null; }
  }
  let result = value.replace(/^([A-Za-z]):\//, (_, drive) => `/${drive.toLowerCase()}/`);
  if (cygpath) {
    try { result = execFileSync(cygpath, ['-u', value], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim(); }
    catch { /* Keep the ordinary drive spelling when Git has no converter. */ }
  }
  msysPaths.set(value, result);
  return result;
}

import { pathToFileURL } from 'node:url';

// Explicit tool adaptation, not an operating-system mount namespace.

// A per-agent namespace. Never create a shared /workspace symlink: concurrent
// agents must map the same visible path to different checkouts.
function shellWords(text) {
  const words = [];
  for (let i = 0; i < text.length;) {
    if (/[\s;&|()<>]/.test(text[i])) { i++; continue; }
    const start = i;
    let value = '', quote = null, literal = true;
    for (; i < text.length; i++) {
      const c = text[i];
      if (!quote && /[\s;&|()<>]/.test(c)) break;
      if (c === '\\' && quote !== "'") {
        if (i + 1 < text.length) { value += text[++i]; continue; }
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

export function createWorkspacePaths(directory, originalRoot = directory, sourceAlias = originalRoot) {
  // Rust canonicalize() emits extended Windows paths. Node and Git Bash also
  // expose normal drive paths and /c/... spellings of the same directory.
  const hostPath = value => {
    if (process.platform !== 'win32') return value;
    if (value.startsWith('\\\\?\\UNC\\')) return `\\\\${value.slice(8)}`;
    return value.startsWith('\\\\?\\') ? value.slice(4) : value;
  };
  const root = hostPath(realpathSync(hostPath(directory)));
  // The source can be inaccessible under macOS/Linux isolation; never stat it.
  const base = hostPath(resolve(originalRoot));
  const WORKSPACE_PATH = base;
  const variants = value => {
    if (process.platform !== 'win32') return [value];
    const native = hostPath(value);
    const slash = native.replaceAll('\\', '/');
    const extended = native.startsWith('\\\\') ? `\\\\?\\UNC\\${native.slice(2)}` : `\\\\?\\${native}`;
    const drive = slash.replace(/^([A-Za-z]):\//, (_, letter) => `/${letter.toLowerCase()}/`);
    return [native, slash, extended, extended.replaceAll('\\', '/'), drive, msysPath(slash)];
  };
  const aliases = [...new Set([...new Set([resolve(directory), root])].flatMap(variants))].sort((a, b) => b.length - a.length);
  const projects = [...new Set([...new Set([base, resolve(sourceAlias)])].flatMap(variants))].sort((a, b) => b.length - a.length);
  const boundary = c => c === undefined || /[\s\\/"'`<>:;,&|()\[\]{}]/.test(c);
  function replace(text, source, replacement) {
    if (typeof text !== 'string') return text;
    let output = '', cursor = 0;
    for (;;) {
      const at = text.indexOf(source, cursor);
      if (at < 0) return output + text.slice(cursor);
      output += text.slice(cursor, at);
      const after = at + source.length;
      const end = boundary(text[after]) || (text[after] === '.' && (text[after + 1] === undefined || /\s/.test(text[after + 1])));
      const valid = (at === 0 || boundary(text[at - 1]) || text[at - 1] === '=' || text[at - 1] === '\\') && (end || text.slice(after, after + 3).toLowerCase() === '%2f' || text.slice(after, after + 2) === '\\/');
      output += valid ? replacement : source;
      cursor = at + source.length;
    }
  }
  const spellings = [
    value => value,
    value => JSON.stringify(value).slice(1, -1),
    value => value.replaceAll('/', '\\/'),
    value => value.replaceAll('\\', '/'),
    value => value.replaceAll('\\', '\\\\'),
    value => value.replace(/[^a-zA-Z0-9_./\\-]/g, character => `\\${character}`),
    value => value.replaceAll("'", "'\\''"),
    value => pathToFileURL(value).href,
    value => encodeURI(value),
    value => encodeURIComponent(value),
  ];
  // Plain filesystem paths are presented relative to the project root. Keep
  // structured URI encodings valid; do not turn file URLs into file://./... .
  const replacements = [...new Map(aliases.flatMap(alias => spellings.map((encode, index) => [encode(alias), index >= 7 ? encode(base) : '.'])).reverse()).entries()]
    .sort(([a], [b]) => b.length - a.length);
  const pathPrefix = (value, prefix) => value === prefix || value.startsWith(prefix + '/') || value.startsWith(prefix + '\\');
  const commandPrefixes = [...new Set(variants(WORKSPACE_PATH))].sort((a, b) => b.length - a.length);
  const commandRoot = process.platform === 'win32' ? root.replaceAll('\\', '/') : root;
  const visible = text => replacements.reduce((value, [alias, project]) => replace(value, alias, project), text);
  const physical = value => {
    if (typeof value !== 'string') return value;
    const project = projects.find(project => pathPrefix(value, project));
    if (!project) return value;
    const suffix = value.slice(project.length).replaceAll('\\', sep).replaceAll('/', sep);
    return root + suffix;
  };
  function mapCommand(text, WORKSPACE_PATH) {
    // A quoted sh -c argument is parsed again by the child shell. Translate at
    // that level first, then quote the entire script for the outer shell.
    const words = shellWords(text);
    const replacements = [];
    for (let i = 0; i < words.length; i++) {
      if (!words[i].literal || !/^(?:\/[^\s]+\/)?(?:sh|bash|zsh|dash)$/.test(words[i].value)) continue;
      for (let j = i + 1; j < words.length && /^-[a-zA-Z]+$/.test(words[j].value); j++) {
        if (!words[j].value.includes('c')) continue;
        const script = words[j + 1];
        if (script?.literal && commandPrefixes.some(prefix => script.value.includes(prefix))) {
          replacements.push({ ...script, replacement: shellQuote(mapCommand(script.value, WORKSPACE_PATH)) });
          i = j + 1;
        }
        break;
      }
    }
    for (const item of replacements.reverse()) text = text.slice(0, item.start) + item.replacement + text.slice(item.end);
    // Preserve shell quoting when the actual checkout contains spaces, quotes or
    // expansion characters. Only translate literal workspace paths, not names
    // such as /workspace-other.
    let result = '', quote = null;
    const parentheses = [];
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      const source = commandPrefixes.find(prefix => text.startsWith(prefix, i)
        && (i === 0 || boundary(text[i - 1]) || text[i - 1] === '=')
        && boundary(text[i + prefix.length]));
      if (source) {
        const shellPath = commandRoot;
        result += quote === "'" ? shellPath.replaceAll("'", "'\\''") : quote === '"' ? shellPath.replace(/[\\$`\"]/g, '\\$&') : shellQuote(shellPath);
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
      if (text.startsWith(WORKSPACE_PATH, i) && (i === 0 || boundary(text[i - 1]) || text[i - 1] === '=') && boundary(text[i + WORKSPACE_PATH.length])) {
        result += quote === "'" ? root.replaceAll("'", "'\\''") : quote === '"' ? root.replace(/[\\$`"]/g, '\\$&') : "'" + root.replaceAll("'", "'\\''") + "'";
        i += WORKSPACE_PATH.length - 1;
        continue;
      }
      if (c === "'" || c === '"') { if (quote === c) quote = null; else if (!quote) quote = c; }
      result += c;
    }
    return result;
  }
  function command(text) {
    // Preserve literal shell arguments with escaped spaces/quotes in the source
    // prefix. Only re-quote complete literal path/assignment tokens; never eval.
    const edits = [];
    for (const word of shellWords(text)) {
      if (!word.literal || text.slice(word.start, word.end).includes('\n')) continue;
      const assignment = word.value.match(/^([A-Za-z_][A-Za-z_0-9]*=|--[A-Za-z_][A-Za-z_0-9-]*=)(.*)$/s);
      const prefix = assignment?.[1] ?? '';
      const value = assignment?.[2] ?? word.value;
      const project = projects.find(project => pathPrefix(value, project));
      if (!project) continue;
      // Unquoted globs must retain glob semantics; the scanner below handles them.
      if (/[*?\[\]{}]/.test(value)) continue;
      edits.push({ ...word, replacement: prefix + shellQuote(commandRoot + value.slice(project.length).replaceAll('\\', '/')) });
    }
    for (const edit of edits.reverse()) text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
    return projects.reduce((value, project) => mapCommand(value, project), text);
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
