// Regenerate the model-data manifest for a merged catalog (pinned baseline plus
// a local overlay). Imports the pinned Pi implementation so the produced bytes
// are exactly what upstream validation expects.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createModelDataManifest,
  MODEL_DATA_MANIFEST_FILE,
  readModelDataStructure,
} from '../pi/packages/ai/scripts/model-data.ts';

// Same fixed stamp as upstream catalog hydration: identical merged input yields
// identical bytes, so rebuilds stay reproducible.
const HYDRATION_STAMP = '1970-01-01T00:00:00.000Z';

export function regenerateModelDataManifest(packageRoot) {
  const dataDir = join(packageRoot, 'src', 'providers', 'data');
  const structure = readModelDataStructure(packageRoot);
  const files = Object.fromEntries(readdirSync(dataDir)
    .filter(name => name.endsWith('.json') && name !== MODEL_DATA_MANIFEST_FILE)
    .map(name => [name, readFileSync(join(dataDir, name), 'utf8')]));
  const manifest = createModelDataManifest(structure, files, HYDRATION_STAMP);
  writeFileSync(join(dataDir, MODEL_DATA_MANIFEST_FILE), `${JSON.stringify(manifest)}\n`);
  return manifest;
}
