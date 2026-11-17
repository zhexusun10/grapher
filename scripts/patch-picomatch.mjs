import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

export const patchedAdvisoryUrl = 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf';
const singleBranchMarkers = [
  'const isSelfRepeatingStarBranch = branch => {',
  'analysis.collapse === true',
];
const multiBranchMarkers = [
  'const hasUnescapedStar = branch => {',
  'branches.length > 1 && branches.some(hasUnescapedStar)',
];

export async function patchPicomatch(installationRoot) {
  const packagePath = join(installationRoot, 'node_modules/picomatch/package.json');
  const sourcePath = join(installationRoot, 'node_modules/picomatch/lib/parse.js');

  let packageJson;
  let source;
  try {
    [packageJson, source] = await Promise.all([
      readFile(packagePath, 'utf8').then(JSON.parse),
      readFile(sourcePath, 'utf8'),
    ]);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }

  // Vite currently resolves picomatch 4.0.7. Apply the upstream proposed fix
  // while waiting for the maintainer to publish a patched release:
  // https://github.com/micromatch/picomatch/pull/237
  if (packageJson.version !== '4.0.7') return false;

  const hasSingleBranchPatch = singleBranchMarkers.every(marker => source.includes(marker));
  if (hasSingleBranchPatch && multiBranchMarkers.every(marker => source.includes(marker))) return true;
  if (multiBranchMarkers.some(marker => source.includes(marker)) ||
      (!hasSingleBranchPatch && singleBranchMarkers.some(marker => source.includes(marker)))) {
    throw new Error(`picomatch ReDoS patch is only partially applied; review ${sourcePath}`);
  }

  function replaceOnce(input, oldText, newText) {
    const first = input.indexOf(oldText);
    if (first === -1 || input.indexOf(oldText, first + oldText.length) !== -1) {
      throw new Error(`Could not uniquely apply picomatch patch near: ${oldText.slice(0, 70)}`);
    }
    return input.slice(0, first) + newText + input.slice(first + oldText.length);
  }

  if (!hasSingleBranchPatch) {
    source = replaceOnce(source, 'const repeatedExtglobRecursion = pattern => {', `const isSelfRepeatingStarBranch = branch => {
  let escaped = false;
  let bracket = false;
  let star = false;

  for (let i = 0; i < branch.length; i++) {
    const ch = branch[i];

    if (escaped === true) {
      escaped = false;
      continue;
    }

    if (ch === '\\\\') {
      escaped = true;
      continue;
    }

    if (bracket === true) {
      if (ch === ']') bracket = false;
      continue;
    }

    if (ch === '[') {
      bracket = true;
      continue;
    }

    if (/[/(){}|!+@]/.test(ch)) return false;

    if (ch === '*') {
      if (branch[i + 1] === '*') return false;
      star = true;
    }
  }

  return star && !escaped && !bracket;
};

const repeatedExtglobRecursion = pattern => {`);

    source = replaceOnce(source, `  if (sawStarSequence) {
    return combinable
      ? { risky: true, safeOutput: buildCharClassStar([...new Set(safeChars)]) }
      : { risky: true };
  }

  return { risky: false };`, `  if (sawStarSequence) {
    return combinable
      ? { risky: true, safeOutput: buildCharClassStar([...new Set(safeChars)]) }
      : { risky: true };
  }

  if (branches.length === 1 && isSelfRepeatingStarBranch(branches[0])) {
    return { risky: false, collapse: true };
  }

  return { risky: false };`);

    source = replaceOnce(source, `    let output = token.close + (opts.capture ? ')' : '');`, `    if (analysis.collapse === true && (token.type === 'plus' || token.type === 'star')) {
      token.close = token.type === 'plus' ? ')' : ')?';
    }

    let output = token.close + (opts.capture ? ')' : '');`);
  }

  source = replaceOnce(source, `  if (sawStarSequence) {
    return combinable
      ? { risky: true, safeOutput: buildCharClassStar([...new Set(safeChars)]) }
      : { risky: true };
  }

  if (branches.length === 1 && isSelfRepeatingStarBranch(branches[0])) {
    return { risky: false, collapse: true };
  }

  return { risky: false };`, `  if (sawStarSequence) {
    return combinable
      ? { risky: true, safeOutput: buildCharClassStar([...new Set(safeChars)]) }
      : { risky: true };
  }

  if (branches.length > 1 && branches.some(hasUnescapedStar)) {
    return { risky: true };
  }

  if (branches.length === 1 && isSelfRepeatingStarBranch(branches[0])) {
    return { risky: false, collapse: true };
  }

  return { risky: false };`);

  source = replaceOnce(source, 'const repeatedExtglobRecursion = pattern => {', `const hasUnescapedStar = branch => {
  let escaped = false;
  let bracket = false;

  for (const ch of branch) {
    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === '\\\\') {
      escaped = true;
      continue;
    }

    if (bracket) {
      if (ch === ']') bracket = false;
      continue;
    }

    if (ch === '[') bracket = true;
    else if (ch === '*') return true;
  }

  return false;
};

const repeatedExtglobRecursion = pattern => {`);

  await writeFile(sourcePath, source);
  return true;
}

export async function verifyPicomatchPatch(installationRoot) {
  const packagePath = join(installationRoot, 'node_modules/picomatch/package.json');
  const sourcePath = join(installationRoot, 'node_modules/picomatch/lib/parse.js');
  try {
    const [packageJson, source] = await Promise.all([
      readFile(packagePath, 'utf8').then(JSON.parse),
      readFile(sourcePath, 'utf8'),
    ]);
    return packageJson.version === '4.0.7' &&
      [...singleBranchMarkers, ...multiBranchMarkers].every(marker => source.includes(marker));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? fileURLToPath(new URL('../', import.meta.url)));
  try {
    await patchPicomatch(root);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
