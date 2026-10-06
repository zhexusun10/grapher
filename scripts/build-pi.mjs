// Equivalent reviewed Pi offline build, using Node filesystem operations instead
// of the vulnerable shx -> shelljs -> fast-glob -> micromatch -> braces chain.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { corePackages, verifyPiDependencies } from './pi-dependencies.mjs';
import { root, source, verifyBaseline } from './pi-baseline.mjs';
import { toolchainEnv } from './cargo.mjs';

export function verifyBuildScripts(directory) {
  const expected = {
    chord: { build: 'tsc -p tsconfig.build.json' },
    tui: { build: 'tsc -p tsconfig.build.json' },
    telemetry: { build: 'tsc -p tsconfig.build.json' },
    codemode: { build: 'tsc -p tsconfig.build.json' },
    mcp: { build: 'tsc -p tsconfig.build.json' },
    ai: {
      build: 'npm run generate-models && npm run build:offline',
      'build:offline': 'npm run check:model-data && tsc -p tsconfig.build.json && shx rm -rf dist/providers/data && shx cp -r src/providers/data dist/providers/data',
    },
    durable: { build: 'tsc -p tsconfig.build.json' },
    agent: { build: 'tsc -p tsconfig.build.json' },
    protocol: { build: 'tsc -p tsconfig.build.json' },
    client: { build: 'tsc -p tsconfig.build.json' },
    server: { build: 'tsc -p tsconfig.build.json' },
    'coding-agent': {
      build: 'npm run build:unbundled && node ../../scripts/build-coding-agent-bundle.mjs',
      'build:unbundled': 'tsc -p tsconfig.build.json && shx chmod +x dist/cli.js dist/rpc-entry.js && npm run copy-assets',
      'copy-assets': 'shx mkdir -p dist/modes/interactive/theme && shx cp src/modes/interactive/theme/*.json dist/modes/interactive/theme/ && shx mkdir -p dist/modes/interactive/assets && shx cp src/modes/interactive/assets/*.png dist/modes/interactive/assets/ && shx mkdir -p dist/core/export-html/vendor && shx cp src/core/export-html/template.html src/core/export-html/template.css src/core/export-html/template.js dist/core/export-html/ && shx cp src/core/export-html/vendor/*.js dist/core/export-html/vendor/',
    },
  };
  for (const name of corePackages) {
    const { scripts } = JSON.parse(readFileSync(join(directory, 'packages', name, 'package.json'), 'utf8'));
    for (const [script, command] of Object.entries(expected[name])) {
      if (scripts[script] !== command) throw new Error(`Review updated Pi build pipeline: ${name}:${script}`);
    }
  }
}

export function copyPiAssets(directory) {
  const ai = join(directory, 'packages/ai');
  rmSync(join(ai, 'dist/providers/data'), { recursive: true, force: true });
  cpSync(join(ai, 'src/providers/data'), join(ai, 'dist/providers/data'), { recursive: true });
  const coding = join(directory, 'packages/coding-agent');
  const copyMatching = (folder, extension) => {
    const input = join(coding, 'src', folder);
    const output = join(coding, 'dist', folder);
    const names = readdirSync(input).filter(name => name.endsWith(extension));
    if (!names.length) throw new Error(`Missing Pi assets: ${folder}`);
    mkdirSync(output, { recursive: true });
    for (const name of names) copyFileSync(join(input, name), join(output, name));
  };
  copyMatching('modes/interactive/theme', '.json');
  copyMatching('modes/interactive/assets', '.png');
  copyMatching('core/export-html/vendor', '.js');
  for (const name of ['template.html', 'template.css', 'template.js']) {
    const outputDirectory = join(coding, 'dist/core/export-html');
    mkdirSync(outputDirectory, { recursive: true });
    copyFileSync(join(coding, 'src/core/export-html', name), join(outputDirectory, name));
  }
  for (const name of ['cli.js', 'rpc-entry.js']) chmodSync(join(coding, 'dist', name), 0o755);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    verifyBaseline();
    verifyPiDependencies(root);
    verifyBuildScripts(source);
    const run = (cwd, ...args) => execFileSync(process.execPath, args, { cwd, stdio: 'inherit', env: toolchainEnv() });
    run(join(source, 'packages/ai'), join(source, 'packages/ai/scripts/check-model-data.ts'));
    // Don't let deleted outputs from the previous Pi revision survive rebuilding.
    for (const name of corePackages) rmSync(join(source, 'packages', name, 'dist'), { recursive: true, force: true });
    for (const name of corePackages) {
      console.log(`Building Pi ${name}...`);
      run(join(source, 'packages', name), join(source, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json');
      if (name === 'ai') cpSync(join(source, 'packages/ai/src/providers/data'), join(source, 'packages/ai/dist/providers/data'), { recursive: true });
    }
    copyPiAssets(source);
    run(source, join(source, 'scripts/build-coding-agent-bundle.mjs'));
    console.log('Pi offline artifacts built without shx or example dependencies.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
