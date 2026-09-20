import { realpathSync } from 'node:fs';
import { posix, resolve } from 'node:path';

// Workspace path is now dynamically constructed based on the original repository root

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

export function createWorkspacePaths(directory, originalRoot = process.env.GRAPHER_ORIGINAL_ROOT || process.env.GRAPHER_WORKSPACE_ROOT || directory) {
  const root = realpathSync(directory);
  const base = realpathSync(originalRoot);
  const WORKSPACE_PATH = `${posix.dirname(base)}/workspace/${posix.basename(base)}`;
  const aliases = [...new Set([resolve(directory), root])].sort((a, b) => b.length - a.length);
  const boundary = c => c === undefined || /[\s/"'`<>:;,&|()\[\]{}]/.test(c);
  function replace(text, source, replacement) {
    if (typeof text !== 'string') return text;
    let output = '', cursor = 0;
    for (;;) {
      const at = text.indexOf(source, cursor);
      if (at < 0) return output + text.slice(cursor);
      output += text.slice(cursor, at);
      const after = at + source.length;
      const end = boundary(text[after]) || (text[after] === '.' && (text[after + 1] === undefined || /\s/.test(text[after + 1])));
      const valid = (at === 0 || boundary(text[at - 1]) || text[at - 1] === '=') && end;
      output += valid ? replacement : source;
      cursor = at + source.length;
    }
  }
  const visible = text => aliases.reduce((value, alias) => replace(value, alias, WORKSPACE_PATH), text);
  const physical = value => {
    if (typeof value !== 'string') return value;
    // Path arguments are paths, not prose: punctuation is part of the filename.
    if (value !== WORKSPACE_PATH && !value.startsWith(WORKSPACE_PATH + '/')) return value;
    // Translate only the prefix; let the filesystem resolve .. and symlinks.
    return root + value.slice(WORKSPACE_PATH.length);
  };
  function command(text) {
    // A quoted sh -c argument is parsed again by the child shell. Translate at
    // that level first, then quote the entire script for the outer shell.
    const words = shellWords(text);
    const replacements = [];
    for (let i = 0; i < words.length; i++) {
      if (!words[i].literal || !/^(?:\/[^\s]+\/)?(?:sh|bash|zsh|dash)$/.test(words[i].value)) continue;
      for (let j = i + 1; j < words.length && /^-[a-zA-Z]+$/.test(words[j].value); j++) {
        if (!words[j].value.includes('c')) continue;
        const script = words[j + 1];
        if (script?.literal && script.value.includes(WORKSPACE_PATH)) {
          replacements.push({ ...script, replacement: shellQuote(command(script.value)) });
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
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '\\' && quote !== "'") { result += text.slice(i, i + 2); i++; continue; }
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
  function view(value) {
    if (typeof value === 'string') return visible(value);
    if (Array.isArray(value)) return value.map(view);
    if (value && typeof value === 'object') {
      // Opaque provider signatures and image bytes must survive context mapping.
      if (value.type === 'image' || value.type === 'thinking' || value.type === 'redactedThinking') return value;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
        ['signature', 'textSignature', 'thinkingSignature', 'id', 'toolCallId'].includes(key) ? item : view(item),
      ]));
    }
    return value;
  }
  return { root, visible, physical, command, view, WORKSPACE_PATH };
}

export function registerWorkspacePaths(pi, directory, { shellCommands = true, originalRoot } = {}) {
  const paths = createWorkspacePaths(directory, originalRoot);
  pi.on('before_agent_start', async event => ({ systemPrompt: paths.visible(event.systemPrompt) }));
  // Covers user prompts, resumed conversation and tool results before model input.
  pi.on('context', async event => ({ messages: paths.view(event.messages) }));
  pi.on('tool_call', async event => {
    try {
      const input = event.input;
      if (shellCommands && event.toolName === 'bash' && typeof input.command === 'string') input.command = paths.command(input.command);
      for (const field of ['path', 'cwd', 'directory']) {
        if (typeof input[field] === 'string') input[field] = paths.physical(input[field]);
      }
      if (Array.isArray(input.paths)) input.paths = input.paths.map(path => paths.physical(path));
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
  });
  pi.on('tool_result', async event => ({ content: paths.view(event.content), details: paths.view(event.details) }));
  return paths;
}
