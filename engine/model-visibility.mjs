// Global Grapher model-picker scope, independent of Run model selections.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { toHostInput } from './path-identity.mjs';

const directory = () => toHostInput(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.grapher', 'pi-agent'));
const validId = id => typeof id === 'string' && id.includes('/') && id.trim() === id && id.length <= 2048;

export function readModelVisibility(dir = directory()) {
  let content;
  try { content = readFileSync(join(dir, 'model-visibility.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { hiddenModels: [] }; throw error; }
  const value = JSON.parse(content);
  if (!Array.isArray(value.hiddenModels) || !value.hiddenModels.every(validId)) throw new Error('Invalid model visibility settings');
  return { hiddenModels: [...new Set(value.hiddenModels)] };
}

export function saveModelVisibility(changes, reset = false, dir = directory()) {
  if (!Array.isArray(changes) || changes.length > 10000 || changes.some(change =>
    !change || !validId(change.model) || typeof change.hidden !== 'boolean') || typeof reset !== 'boolean') {
    throw new Error('Invalid model visibility update');
  }
  // The Provider/Auth transport serializes writes. Merge only edited entries
  // with the latest file, so independent tabs don't overwrite unrelated edits.
  const hidden = new Set(reset ? [] : readModelVisibility(dir).hiddenModels);
  for (const change of changes) {
    if (change.hidden) hidden.add(change.model); else hidden.delete(change.model);
  }
  const result = { hiddenModels: [...hidden].sort() };
  mkdirSync(dir, { recursive: true });
  const target = join(dir, 'model-visibility.json');
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(result, null, 2), { mode: 0o600 });
    renameSync(temporary, target);
  } finally { rmSync(temporary, { force: true }); }
  return result;
}
