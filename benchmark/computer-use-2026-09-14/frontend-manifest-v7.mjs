// Compare layout/service source fingerprints at the start and final state of
// validation so long-running browser evidence can identify the exact bundle.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const repo = path.resolve(import.meta.dirname, '../..');
const files = ['src/App.tsx', 'src/components/ExecutionTranscript.tsx', 'src/components/VirtualizedTranscript.tsx', 'src/components/ThinkingCard.tsx', 'src/components/ToolCallCard.tsx', 'src/services/runtime.ts', 'src/services/planningRecovery.ts', 'src/services/transcriptLayout.ts'];
const evidence = Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(repo, file))).digest('hex')]));
fs.writeFileSync(path.join(import.meta.dirname, 'v7-validation/final-frontend-manifest.json'), JSON.stringify(evidence, null, 2) + '\n');
