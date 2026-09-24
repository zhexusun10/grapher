import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  ModelRuntime, SettingsManager, resolveToCwd,
  createBashToolDefinition, createLocalBashOperations,
  createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
  createLsToolDefinition, createFindToolDefinition, createGrepToolDefinition,
} from '../engine/pi-compat.ts';

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
