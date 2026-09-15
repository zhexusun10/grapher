// Planner's `bash` is a command-shaped inspection API, NOT a shell interpreter.
// No repository executables, environment/config files, subprocess expansion or curl config.
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';

export const INSPECTION_POLICY = 'repository-inspection-v1';
const MAX_OUTPUT = 64 * 1024;
const MAX_FILE = 256 * 1024;
const MAX_SCAN = 4 * 1024 * 1024;
const fail = (message) => { throw new Error(`Read-only inspection: ${message}`); };

export function repositoryPath(root, input = '.', fileOnly = false) {
  root = realpathSync(root);
  const path = resolve(root, input);
  const child = relative(root, path);
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) fail('path is outside this repository');
  let current = root;
  for (const part of child.split(sep).filter(Boolean)) {
    if (part === '.git') fail('Git metadata is not an inspection input');
    current = resolve(current, part);
    if (lstatSync(current).isSymbolicLink()) fail('symlinks are not inspection inputs');
  }
  const stat = lstatSync(path);
  if (!stat.isFile() && !stat.isDirectory()) fail('only regular files and directories are readable');
  if (fileOnly && !stat.isFile()) fail('expected a regular file');
  return path;
}

// Deliberately small grammar. Quotes group arguments, not executable shell syntax.
export function splitCommand(command) {
  if (typeof command !== 'string' || command.length > 8192 || /[\n\r\0`$]/.test(command)) fail('no expansion, multiline commands or shell execution');
  const args = []; let word = '', quote = null, started = false;
  for (const c of command) {
    if (quote) {
      if (c === quote) quote = null; else word += c;
    } else if (c === '"' || c === "'") { quote = c; started = true; }
    else if (/\s/.test(c)) { if (started) { args.push(word); word = ''; started = false; } }
    else if (/[;&|<>\\()]/.test(c)) fail('no chaining, pipes, redirects, escapes or substitutions; use separate calls. File discovery already skips .git and node_modules and caps output; use rg --files [path] or find [path] -maxdepth N without a pipe');
    else { word += c; started = true; }
  }
  if (quote) fail('unclosed quote');
  if (started) args.push(word);
  if (!args.length) fail('empty command');
  return args;
}

function readText(root, path) {
  path = repositoryPath(root, path, true);
  if (lstatSync(path).size > MAX_FILE) fail('file exceeds 256 KiB; use read with offset/limit');
  return readFileSync(path, 'utf8');
}
function walk(root, input, maxDepth = 32) {
  const result = []; let visited = 0;
  function visit(path, depth) {
    if (++visited > 10000) fail('inspection exceeds 10000 entries; choose a narrower directory');
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    repositoryPath(root, path);
    result.push({ path, directory: stat.isDirectory() });
    if (stat.isDirectory() && depth < maxDepth) {
      for (const name of readdirSync(path).sort()) {
        if (['.git', 'node_modules'].includes(name)) continue;
        visit(resolve(path, name), depth + 1);
      }
    }
  }
  visit(repositoryPath(root, input), 0);
  return result;
}
const display = (root, path) => relative(root, path) || '.';
const number = (value, max) => {
  if (!/^\d+$/.test(value ?? '') || Number(value) > max) fail(`expected integer between 0 and ${max}`);
  return Number(value);
};
function glob(pattern, insensitive) {
  if (pattern.length > 256) fail('glob too long');
  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, insensitive ? 'i' : '');
}

// Only globally routable addresses. Deny local, private, link-local, multicast,
// documentation/benchmark ranges, IPv4-mapped IPv6 and transition mechanisms.
export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    const first = parseInt(address.split(':')[0], 16);
    return first >= 0x2000 && first <= 0x3fff && !/^200[12]:/i.test(address) && !/^3fff:/i.test(address);
  }
  return false;
}
export function parseCurl(args) {
  let method = 'GET', follow = false, failHttp = false, target;
  for (const arg of args) {
    if (/^-[fsSIL]+$/.test(arg)) {
      if (arg.includes('f')) failHttp = true;
      if (arg.includes('I')) method = 'HEAD';
      if (arg.includes('L')) follow = true;
    } else if (arg === '--head') method = 'HEAD';
    else if (arg === '--location') follow = true;
    else if (arg.startsWith('-')) fail('curl supports only -f/-s/-S/-I/-L, --head and --location; no uploads, headers, config or output files');
    else if (target) fail('curl accepts exactly one URL');
    else target = arg;
  }
  if (!target) fail('curl needs one public HTTP(S) URL');
  const url = validateUrl(target);
  return { url, method, follow, failHttp };
}
function validateUrl(target) {
  const url = new URL(target);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) fail('only public HTTP(S) URLs on default ports, without credentials');
  return url;
}
export async function fetchPublic({ url, method, follow, failHttp }, signal, remaining = 4, network = {
  lookup,
  request: (url, options, callback) => (url.protocol === 'https:' ? https : http).request(url, options, callback),
}) {
  url = validateUrl(url);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) fail('local network requests are forbidden');
  signal?.throwIfAborted();
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await new Promise((resolveLookup, reject) => {
    const abort = () => reject(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => network.lookup(hostname, { all: true })).then(resolveLookup, reject)
      .finally(() => signal?.removeEventListener('abort', abort));
  });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) fail('local/private/reserved network requests are forbidden');
  // Pin the checked address: do not perform a second DNS lookup when connecting.
  const address = addresses[0];
  const response = await new Promise((resolveResponse, reject) => {
    const request = network.request(url, {
      method, agent: false, signal,
      headers: { Accept: 'text/plain, text/html, application/json', 'User-Agent': 'Grapher-Planner-Inspection/1' },
      lookup: (_host, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family),
    }, (response) => {
      let size = 0; const chunks = [];
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_OUTPUT) { request.destroy(new Error('Read-only inspection: HTTP response exceeds 64 KiB')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolveResponse({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end();
  });
  if (follow && [301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
    if (!remaining) fail('too many redirects');
    return fetchPublic({ url: new URL(response.headers.location, url), method, follow, failHttp }, signal, remaining - 1, network);
  }
  if (failHttp && response.status >= 400) fail(`HTTP ${response.status}`);
  return `HTTP ${response.status}\n${method === 'HEAD' ? JSON.stringify(response.headers, null, 2) : response.body}`;
}

export async function inspectCommand(root, command, signal) {
  signal?.throwIfAborted();
  root = realpathSync(root);
  const [program, ...args] = splitCommand(command);
  let text;
  if (program === 'curl') {
    const timeout = AbortSignal.timeout(15000);
    text = await fetchPublic(parseCurl(args), signal ? AbortSignal.any([signal, timeout]) : timeout);
  } else if (program === 'pwd') {
    if (args.length) fail('pwd takes no arguments');
    text = '.'; // Do not leak the host checkout path into generated tasks.
  } else if (program === 'ls') {
    const paths = [];
    for (const arg of args) { if (/^-[lah]+$/.test(arg)) continue; if (arg.startsWith('-')) fail('unsupported ls option'); paths.push(arg); }
    if (paths.length > 1) fail('ls accepts one directory');
    const path = repositoryPath(root, paths[0] ?? '.');
    text = lstatSync(path).isDirectory() ? readdirSync(path).filter(n => n !== '.git').sort().map(n => {
      const entry = lstatSync(resolve(path, n));
      return n + (entry.isSymbolicLink() ? ' [symlink; not readable]' : entry.isDirectory() ? '/' : '');
    }).join('\n') : display(root, path);
  } else if (program === 'find' || (program === 'rg' && args[0] === '--files')) {
    const tokens = [...args];
    if (program === 'rg') tokens.shift();
    const path = tokens[0] && !tokens[0].startsWith('-') ? tokens.shift() : '.';
    let pattern = null, type = program === 'rg' ? 'f' : null, depth = 32;
    const includes = [], excludes = [];
    while (tokens.length) {
      const flag = tokens.shift(), value = tokens.shift();
      if (program === 'rg' && (flag === '-g' || flag === '--glob')) {
        if (!value) fail('-g/--glob requires a file glob');
        const negative = value.startsWith('!');
        const input = negative ? value.slice(1) : value;
        (negative ? excludes : includes).push({ regex: glob(input, false), fullPath: input.includes('/') });
      }
      else if (flag === '-name' || flag === '-iname') pattern = glob(value ?? '', flag === '-iname');
      else if (flag === '-type' && ['f', 'd'].includes(value)) type = value;
      else if (flag === '-maxdepth') depth = number(value, 32);
      else fail('find supports only path, -name/-iname glob, -type f/d and -maxdepth N. For filtered file discovery use rg --files [path] -g glob; .git and node_modules are skipped automatically');
    }
    text = walk(root, path, depth).filter(e => {
      const name = display(root, e.path);
      const matches = ({ regex, fullPath }) => regex.test(fullPath ? name : name.split(sep).at(-1));
      return (!type || e.directory === (type === 'd')) && (!pattern || pattern.test(e.path.split(sep).at(-1)))
        && (!includes.length || includes.some(matches)) && !excludes.some(matches);
    }).map(e => display(root, e.path)).join('\n');
  } else if (['cat', 'head', 'tail'].includes(program)) {
    const tokens = [...args]; let count = 10;
    if (program !== 'cat') {
      if (tokens[0] === '-n') { tokens.shift(); count = number(tokens.shift(), 2000); }
      else if (/^-(?:n)?\d+$/.test(tokens[0] ?? '')) { count = number(tokens.shift().replace(/^-(?:n)?/, ''), 2000); }
    }
    if (!tokens.length || tokens.some(p => p.startsWith('-'))) fail(`${program} requires file paths; head/tail support -n N, -nN or -N (0..2000)`);
    text = tokens.map(path => {
      const contents = readText(root, path);
      if (program === 'cat') return contents;
      const lines = contents.replace(/\n$/, '').split('\n');
      return (program === 'head' ? lines.slice(0, count) : count ? lines.slice(-count) : []).join('\n');
    }).join('\n');
  } else if (program === 'grep' || program === 'rg') {
    const tokens = [...args]; let insensitive = false, literal = false, namesOnly = false;
    const includes = [], excludes = [];
    while (tokens[0]?.startsWith('-') && tokens[0] !== '--') {
      const flag = tokens.shift();
      if (flag === '-g' || flag === '--glob') {
        const value = tokens.shift();
        if (!value) fail('-g/--glob requires a file glob');
        const negative = value.startsWith('!');
        const pattern = negative ? value.slice(1) : value;
        (negative ? excludes : includes).push({ regex: glob(pattern, false), fullPath: pattern.includes('/') });
        continue;
      }
      if (!/^-[nilFrR]+$/.test(flag)) fail('search supports only -n/-i/-l/-F/-r/-R, -g/--glob and --; put options before the pattern');
      insensitive ||= flag.includes('i'); literal ||= flag.includes('F'); namesOnly ||= flag.includes('l');
    }
    if (tokens[0] === '--') tokens.shift();
    const pattern = tokens.shift();
    if (pattern === undefined || pattern.length > 1024) fail('search requires a pattern of at most 1024 characters');
    const paths = tokens.length ? tokens : ['.']; let scanned = 0, outputBytes = 0; const output = [], seen = new Set();
    search: for (const path of paths) for (const entry of walk(root, path)) {
      signal?.throwIfAborted();
      if (entry.directory || seen.has(entry.path) || lstatSync(entry.path).size > MAX_FILE) continue;
      seen.add(entry.path);
      const name = display(root, entry.path);
      const matches = ({ regex, fullPath }) => regex.test(fullPath ? name : name.split(sep).at(-1));
      if ((includes.length && !includes.some(matches)) || excludes.some(matches)) continue;
      const contents = readText(root, entry.path);
      scanned += Buffer.byteLength(contents);
      if (scanned > MAX_SCAN) fail('search exceeds 4 MiB; choose a narrower directory');
      if (contents.includes('\0')) continue;
      // A fixed system grep reads stdin only. No shell, path operands or user-supplied options.
      let matched;
      try {
        const pending = execFileAsync('/usr/bin/grep', [namesOnly ? '-q' : '-n', ...(insensitive ? ['-i'] : []), ...(literal ? ['-F'] : ['-E']), '-e', pattern], {
          encoding: 'utf8', timeout: 1000, maxBuffer: MAX_SCAN, signal,
          env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
        });
        // grep -q may close stdin before the whole file has been written.
        pending.child.stdin.on('error', () => {});
        pending.child.stdin.end(contents);
        matched = await pending;
      } catch (error) {
        signal?.throwIfAborted();
        if (error.code === 1) continue; // No matches is not a tool error.
        fail('search failed or exceeded output/time limit');
      }
      const lines = namesOnly ? [name] : matched.stdout.trimEnd().split('\n').map(line => `${name}:${line}`);
      for (const line of lines) {
        outputBytes += Buffer.byteLength(line) + 1;
        if (outputBytes > MAX_OUTPUT) {
          output.push('[truncated; narrow the query]');
          break search;
        }
        output.push(line);
      }
    }
    text = output.join('\n');
  } else fail('allowed commands: pwd, ls, find, rg, grep, cat, head, tail, curl (GET/HEAD). No shell, scripts, tests or writes');
  signal?.throwIfAborted();
  return Buffer.byteLength(text) > MAX_OUTPUT ? Buffer.from(text).subarray(0, MAX_OUTPUT).toString('utf8').replace(/\uFFFD$/, '') + '\n[truncated; narrow the query]' : text;
}
