import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const packagePath = fileURLToPath(new URL('../node_modules/picomatch/package.json', import.meta.url));
const sourcePath = fileURLToPath(new URL('../node_modules/picomatch/lib/parse.js', import.meta.url));

let packageJson;
let source;
try {
  [packageJson, source] = await Promise.all([
    readFile(packagePath, 'utf8').then(JSON.parse),
    readFile(sourcePath, 'utf8'),
  ]);
} catch (error) {
  if (error.code === 'ENOENT') process.exit(0);
  throw error;
}

// Vite currently resolves picomatch 4.0.7. Apply the upstream proposed fix
// while waiting for the maintainer to publish a patched release:
// https://github.com/micromatch/picomatch/pull/237
if (packageJson.version !== '4.0.7') process.exit(0);

const singleBranchMarkers = [
  'const isSelfRepeatingStarBranch = branch => {',
  'analysis.collapse === true',
];
const multiBranchMarkers = [
  'const hasUnescapedStar = branch => {',
  'branches.length > 1 && branches.some(hasUnescapedStar)',
];
const hasSingleBranchPatch = singleBranchMarkers.every(marker => source.includes(marker));
if (hasSingleBranchPatch && multiBranchMarkers.every(marker => source.includes(marker))) process.exit(0);
if (multiBranchMarkers.some(marker => source.includes(marker)) ||
    (!hasSingleBranchPatch && singleBranchMarkers.some(marker => source.includes(marker)))) {
  throw new Error('picomatch ReDoS patch is only partially applied; review node_modules/picomatch/lib/parse.js');
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
