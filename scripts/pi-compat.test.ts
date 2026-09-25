import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { grapherSystemPrompt } from '../engine/system-prompt.mjs';
import {
  ModelRuntime, SettingsManager, resolveToCwd,
  createBashToolDefinition, createLocalBashOperations,
  createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
  createLsToolDefinition, createFindToolDefinition, createGrepToolDefinition,
} from '../engine/pi-compat.ts';

test('Grapher removes Pi identity and docs sections from the upstream prompt', () => {
  const prompt = [
    'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files.',
    '<rules>\n- Be concise\n</rules>',
    '<docs>\nPi documentation: /path/to/pi/docs\n- Read it when asked about Pi\n</docs>',
    '<cwd>\n/workspace\n</cwd>',
  ].join('\n');
  const sanitized = grapherSystemPrompt(prompt);
  assert.match(sanitized, /^You are an expert coding assistant\. You help users/);
  assert.match(sanitized, /<rules>[\s\S]*<\/rules>/);
  assert.doesNotMatch(sanitized, /operating inside pi, a coding agent harness/);
  assert.doesNotMatch(sanitized, /<docs>|Pi documentation|\/path\/to\/pi\/docs/);
  assert.match(sanitized, /<cwd>[\s\S]*<\/cwd>/);
});

test('Pi SDK surface required by Grapher remains available', () => {
  assert.equal(typeof ModelRuntime.create, 'function');
  assert.equal(typeof SettingsManager.inMemory, 'function');
  const cwd = process.cwd();
  assert.equal(resolveToCwd('file.txt', cwd), join(cwd, 'file.txt'));
  assert.equal(typeof createLocalBashOperations().exec, 'function');
  for (const [name, factory] of Object.entries({
    bash: createBashToolDefinition, read: createReadToolDefinition,
    write: createWriteToolDefinition, edit: createEditToolDefinition,
    ls: createLsToolDefinition, find: createFindToolDefinition,
    grep: createGrepToolDefinition,
  })) {
    const tool = factory(cwd);
    assert.equal(tool.name, name);
    assert.equal(typeof tool.execute, 'function');
    assert.ok(tool.parameters, `${name} must expose its input schema`);
  }
  // This private upstream entrypoint is invoked only after the host retry
  // policy is installed; importing it in a test would start the CLI.
  accessSync(fileURLToPath(new URL('../pi/packages/coding-agent/src/cli.ts', import.meta.url)));
});
