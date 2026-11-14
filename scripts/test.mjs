#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { constants } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { suites, suiteSteps } from './test-suites.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
const testFile = /\.test\.(?:mjs|ts)$/;
const commandText = args => `node ${args.map(arg => /[\s"']/u.test(arg) ? JSON.stringify(arg) : arg).join(' ')}`;

// Validate wiring, not test outcomes. Never import tests or launch prerequisites.
export function checkInventory({ directory = root, catalog = suites } = {}) {
  const scripts = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).scripts;
  const registered = new Set();
  for (const name of Object.keys(catalog)) {
    if (scripts[`test:${name}`] !== `node scripts/test.mjs ${name}`) {
      throw new Error(`Missing or stale npm entry point: test:${name}`);
    }
    const seen = new Set();
    const steps = suiteSteps(name, catalog);
    if (!steps.length) throw new Error(`Empty test suite: ${name}`);
    for (const args of steps) {
      if (!args.length || args.some(arg => typeof arg !== 'string' || !arg)) {
        throw new Error(`Invalid command in test:${name}`);
      }
      for (const path of args.filter(arg => arg.startsWith('scripts/') && /\.(mjs|ts)$/.test(arg))) {
        if (!existsSync(join(directory, path))) throw new Error(`Missing script in test:${name}: ${path}`);
        if (!testFile.test(path)) continue;
        if (seen.has(path)) throw new Error(`Duplicate test in test:${name}: ${path}`);
        seen.add(path);
        registered.add(path);
      }
    }
  }
  for (const [name, command] of Object.entries(scripts)) {
    const match = /^node scripts\/test\.mjs ([\w:-]+)$/.exec(command);
    if (match && !match[1].startsWith('--') && !Object.hasOwn(catalog, match[1])) {
      throw new Error(`Unknown suite in ${name}: ${match[1]}`);
    }
  }
  const discovered = readdirSync(join(directory, 'scripts'), { recursive: true })
    .map(path => `scripts/${path.replaceAll('\\', '/')}`).filter(path => testFile.test(path));
  const missing = discovered.filter(path => !registered.has(path));
  if (missing.length) throw new Error(`Tests without a suite:\n${missing.join('\n')}`);
  return { suites: Object.keys(catalog).length, tests: registered.size };
}

export function runSteps(steps, { cwd = root, env = process.env, spawn = spawnSync,
  log = console.log, error = console.error } = {}) {
  for (const args of steps) {
    log(`\n> ${commandText(args)}`);
    const result = spawn(process.execPath, args, { cwd, env, stdio: 'inherit', shell: false });
    if (result.error) {
      error(result.error.message);
      return 1;
    }
    if (result.signal) return 128 + (constants.signals[result.signal] ?? 1);
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

function main(args) {
  if (args.length === 1 && args[0] === '--check') {
    const inventory = checkInventory();
    console.log(`Test inventory OK: ${inventory.tests} files in ${inventory.suites} suites.`);
    return 0;
  }
  if (args.length === 1 && args[0] === '--list') {
    for (const [name, suite] of Object.entries(suites)) console.log(`test:${name}\t${suite.description}`);
    return 0;
  }
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/test.mjs <suite> [--list] | --list | --check');
    console.log('Use --list to inspect commands without building or running tests. No default/all suite.');
    return 0;
  }
  const [name, option, ...extra] = args;
  if (!name || name.startsWith('-') || (option && option !== '--list') || extra.length) {
    console.error('Usage: node scripts/test.mjs <suite> [--list] | --list | --check');
    console.error('For a single case, invoke its test file directly; see docs/development/testing.md.');
    return 2;
  }
  if (!Object.hasOwn(suites, name)) {
    console.error(`Unknown test suite: ${name}. Use --list to see available suites.`);
    return 2;
  }
  const steps = suiteSteps(name);
  if (option === '--list') {
    for (const step of steps) console.log(commandText(step));
    return 0;
  }
  return runSteps(steps);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
