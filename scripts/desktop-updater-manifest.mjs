// Gather per-target signed Tauri v2 updater artifacts and generate the
// GitHub Releases `latest.json` manifest consumed by `tauri-plugin-updater`.
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_GITHUB_REPOSITORY = 'zhexusun10/grapher';

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const REPO_SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const RFC3339_UTC_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const SECRET_KEY_MARKER_RE =
  /PRIVATE KEY|encrypted secret key|unencrypted secret key|minisign secret key/i;

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// ASN.1 DER SubjectPublicKeyInfo prefix for raw 32-byte Ed25519 public keys.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export const UPDATER_TARGETS = [
  {
    id: 'macos-arm64',
    platformKeys: ['darwin-aarch64', 'darwin-aarch64-app'],
    matchesAsset: fileName => /(?:^|_)(?:aarch64|arm64)\.app\.tar\.gz$/i.test(fileName),
  },
  {
    id: 'macos-x64',
    platformKeys: ['darwin-x86_64', 'darwin-x86_64-app'],
    matchesAsset: fileName => /(?:^|_)(?:x64|x86_64)\.app\.tar\.gz$/i.test(fileName),
  },
  {
    id: 'windows-x64',
    platformKeys: ['windows-x86_64', 'windows-x86_64-nsis'],
    matchesAsset: fileName => /(?:^|_)(?:x64|x86_64)-setup\.exe$/i.test(fileName),
  },
];

export function normalizeVersion(input) {
  const cleaned = String(input ?? '').trim().replace(/^v/i, '');
  if (!SEMVER_RE.test(cleaned)) {
    throw new Error(`Invalid semantic version "${input}". Expected semver like 1.9.9 or v1.9.9.`);
  }
  return cleaned;
}

export function validateRepositorySlug(repo) {
  const cleaned = String(repo ?? '').trim();
  if (!REPO_SLUG_RE.test(cleaned)) {
    throw new Error(`Invalid GitHub repository slug "${repo}". Expected "owner/repo".`);
  }
  return cleaned;
}

export function validateRfc3339Date(dateText) {
  const cleaned = String(dateText ?? '').trim();
  if (!RFC3339_UTC_RE.test(cleaned) || Number.isNaN(Date.parse(cleaned))) {
    throw new Error(`Invalid RFC 3339 pub_date "${dateText}".`);
  }
  return cleaned;
}

export function defaultPubDate(now = new Date()) {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function buildReleaseDownloadUrl(repo, tag, assetFileName) {
  const normalizedRepo = validateRepositorySlug(repo);
  const cleanedTag = String(tag ?? '').trim();
  const cleanedAsset = String(assetFileName ?? '').trim();
  if (!cleanedTag) throw new Error('Release tag must not be empty.');
  if (!cleanedAsset || cleanedAsset.includes('/') || cleanedAsset.includes('\\')) {
    throw new Error(`Invalid release asset filename "${assetFileName}".`);
  }
  const url = `https://github.com/${normalizedRepo}/releases/download/${encodeURIComponent(cleanedTag)}/${encodeURIComponent(cleanedAsset)}`;
  // Validate URL syntax.
  new URL(url);
  return url;
}

/**
 * Extract the section body for `version` from a Keep a Changelog file
 * (`## [1.9.9] - YYYY-MM-DD`), returning `null` if no matching section exists.
 */
export function extractChangelogNotes(changelogText, version) {
  const normalizedVersion = normalizeVersion(version);
  const escaped = normalizedVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lines = String(changelogText ?? '').split(/\r?\n/);
  const headingRe = new RegExp(`^##\\s+\\[?v?${escaped}\\]?(?:\\s+-\\s+.*|\\s*)$`);
  let startIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i].trim())) {
      startIndex = i + 1;
      break;
    }
  }
  if (startIndex < 0) return null;
  const sectionLines = [];
  for (let i = startIndex; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i].trim())) break;
    sectionLines.push(lines[i]);
  }
  const body = sectionLines.join('\n').trim();
  return body || null;
}

/**
 * Validate a Tauri minisign public key string (base64-encoded 2-line minisign `.pub` payload,
 * matching `tauri-plugin-updater`'s `pubkey` config format).
 */
export function validateMinisignPublicKey(pubkeyText, label = 'updater public key') {
  const trimmed = String(pubkeyText ?? '').trim();
  if (!trimmed) {
    throw new Error(`Configured ${label} is empty.`);
  }
  if (SECRET_KEY_MARKER_RE.test(trimmed)) {
    throw new Error(`Refusing to accept secret key material in ${label}.`);
  }
  const compact = trimmed.replace(/\s+/g, '');
  if (compact.length % 4 !== 0 || !BASE64_RE.test(compact)) {
    throw new Error(`Configured ${label} is not valid base64-encoded minisign public key data.`);
  }
  const decoded = Buffer.from(compact, 'base64').toString('utf8');
  if (SECRET_KEY_MARKER_RE.test(decoded)) {
    throw new Error(`Refusing to accept secret key material decoded from ${label}.`);
  }
  const lines = decoded
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(line => line.length > 0);
  if (lines.length !== 2 || !lines[0].startsWith('untrusted comment:') || !BASE64_RE.test(lines[1])) {
    throw new Error(
      `Configured ${label} does not decode to a valid 2-line minisign public key.`,
    );
  }
  const keyBytes = Buffer.from(lines[1], 'base64');
  if (keyBytes.length !== 42 || keyBytes.subarray(0, 2).toString('ascii') !== 'Ed') {
    throw new Error(
      `Configured ${label} does not contain a valid 42-byte Ed25519 minisign public key.`,
    );
  }
  const keyId = keyBytes.subarray(2, 10);
  const rawEd25519 = keyBytes.subarray(10, 42);
  const publicKeyObject = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, rawEd25519]),
    format: 'der',
    type: 'spki',
  });
  return {
    compact,
    keyId,
    keyIdHex: keyId.toString('hex').toUpperCase(),
    publicKeyObject,
  };
}

/**
 * Resolve the effective updater public key using the same precedence as
 * `src-tauri/src/lib.rs`: `GRAPHER_UPDATER_PUBKEY` -> `TAURI_UPDATER_PUBKEY`
 * -> `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.
 */
export function resolveConfiguredUpdaterPubkey({ tauriConfPath = null, env = process.env } = {}) {
  const envPrimary =
    typeof env?.GRAPHER_UPDATER_PUBKEY === 'string' ? env.GRAPHER_UPDATER_PUBKEY.trim() : '';
  if (envPrimary) return envPrimary;
  const envFallback =
    typeof env?.TAURI_UPDATER_PUBKEY === 'string' ? env.TAURI_UPDATER_PUBKEY.trim() : '';
  if (envFallback) return envFallback;
  if (tauriConfPath && existsSync(tauriConfPath)) {
    const conf = JSON.parse(readFileSync(tauriConfPath, 'utf8'));
    const configured =
      typeof conf?.plugins?.updater?.pubkey === 'string'
        ? conf.plugins.updater.pubkey.trim()
        : '';
    if (configured) return configured;
  }
  return null;
}

/**
 * Parse and validate a Tauri minisign `.sig` payload (base64-encoded 4-line minisign signature).
 * Rejects empty files, secret-key leaks, malformed base64/minisign structure, missing signed
 * versions (when `expectedVersion` is provided and `requireVersion` is true), and version mismatches.
 */
export function parseMinisignSignature(
  signatureText,
  expectedVersion = null,
  label = 'signature',
  { requireVersion = Boolean(expectedVersion) } = {},
) {
  const trimmed = String(signatureText ?? '').trim();
  if (!trimmed) {
    throw new Error(`Updater ${label} is empty.`);
  }
  if (SECRET_KEY_MARKER_RE.test(trimmed)) {
    throw new Error(`Refusing to embed secret key material found in updater ${label}.`);
  }
  const compact = trimmed.replace(/\s+/g, '');
  if (compact.length % 4 !== 0 || !BASE64_RE.test(compact)) {
    throw new Error(`Updater ${label} is not valid base64-encoded minisign data.`);
  }
  const decoded = Buffer.from(compact, 'base64').toString('utf8');
  if (SECRET_KEY_MARKER_RE.test(decoded)) {
    throw new Error(`Refusing to embed secret key material decoded from updater ${label}.`);
  }
  const lines = decoded
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(line => line.length > 0);
  if (
    lines.length < 4 ||
    !lines[0].startsWith('untrusted comment:') ||
    !BASE64_RE.test(lines[1]) ||
    !lines[2].startsWith('trusted comment:') ||
    !BASE64_RE.test(lines[3])
  ) {
    throw new Error(
      `Updater ${label} does not decode to a valid 4-line minisign signature.`,
    );
  }

  const sigBlock = Buffer.from(lines[1], 'base64');
  const algorithm = sigBlock.subarray(0, 2).toString('ascii');
  if (sigBlock.length !== 74 || (algorithm !== 'Ed' && algorithm !== 'ED')) {
    throw new Error(
      `Updater ${label} does not contain a valid 74-byte Ed25519 minisign signature block.`,
    );
  }
  const keyId = sigBlock.subarray(2, 10);
  const signatureBytes = sigBlock.subarray(10, 74);
  const globalSignatureBytes = Buffer.from(lines[3], 'base64');
  if (globalSignatureBytes.length !== 64) {
    throw new Error(
      `Updater ${label} does not contain a valid 64-byte minisign global signature.`,
    );
  }

  const trustedComment = lines[2].slice('trusted comment:'.length).trim();
  const versionField = trustedComment
    .split('\t')
    .find(field => field.startsWith('version:'));
  let signedVersion = null;
  if (versionField) {
    signedVersion = versionField.slice('version:'.length).trim().replace(/^v/i, '');
  }
  if (expectedVersion) {
    const expected = normalizeVersion(expectedVersion);
    if (!signedVersion) {
      if (requireVersion) {
        throw new Error(
          `Updater ${label} is missing a signed version in its trusted comment (required by requireSignedVersion for release "${expected}").`,
        );
      }
    } else if (signedVersion !== expected) {
      throw new Error(
        `Updater ${label} is signed for version "${signedVersion}", which does not match release version "${expected}".`,
      );
    }
  }

  return {
    compact,
    algorithm,
    keyId,
    keyIdHex: keyId.toString('hex').toUpperCase(),
    signatureBytes,
    trustedComment,
    globalSignatureBytes,
    signedVersion,
  };
}

/**
 * Validate a Tauri minisign `.sig` payload (base64-encoded minisign signature).
 * Rejects empty files, secret-key leaks, malformed base64/minisign structure,
 * missing signed versions, and version mismatches.
 */
export function validateMinisignSignature(signatureText, expectedVersion = null, label = 'signature') {
  return parseMinisignSignature(signatureText, expectedVersion, label).compact;
}

/**
 * Cryptographically verify a minisign signature against both the payload bytes and
 * the configured minisign public key (Ed25519 payload signature + global trusted-comment
 * signature + Key ID match + signed version binding).
 */
export function verifyMinisignSignatureAgainstPayload({
  payloadBytes,
  signatureText,
  pubkeyText,
  expectedVersion = null,
  label = 'signature',
}) {
  const parsedPubkey = validateMinisignPublicKey(pubkeyText);
  const parsedSig = parseMinisignSignature(signatureText, expectedVersion, label);
  if (!parsedSig.keyId.equals(parsedPubkey.keyId)) {
    throw new Error(
      `Updater ${label} was signed with key ID ${parsedSig.keyIdHex}, which does not match configured public key ID ${parsedPubkey.keyIdHex}.`,
    );
  }
  const payloadBuffer = Buffer.isBuffer(payloadBytes) ? payloadBytes : Buffer.from(payloadBytes);
  const signedData =
    parsedSig.algorithm === 'ED'
      ? createHash('blake2b512').update(payloadBuffer).digest()
      : payloadBuffer;
  const payloadValid = cryptoVerify(
    null,
    signedData,
    parsedPubkey.publicKeyObject,
    parsedSig.signatureBytes,
  );
  if (!payloadValid) {
    throw new Error(
      `Updater ${label} failed Ed25519 payload signature verification against configured public key ${parsedPubkey.keyIdHex}.`,
    );
  }
  const globalData = Buffer.concat([
    parsedSig.signatureBytes,
    Buffer.from(parsedSig.trustedComment, 'utf8'),
  ]);
  const globalValid = cryptoVerify(
    null,
    globalData,
    parsedPubkey.publicKeyObject,
    parsedSig.globalSignatureBytes,
  );
  if (!globalValid) {
    throw new Error(
      `Updater ${label} failed Ed25519 trusted-comment global signature verification against configured public key ${parsedPubkey.keyIdHex}.`,
    );
  }
  return {
    signature: parsedSig.compact,
    keyIdHex: parsedPubkey.keyIdHex,
    signedVersion: parsedSig.signedVersion,
  };
}

export function resolveReleaseNotes({
  version,
  notes = null,
  notesFile = null,
  changelogPath = null,
} = {}) {
  const normalizedVersion = normalizeVersion(version);
  if (typeof notes === 'string' && notes.trim()) {
    return notes.trim();
  }
  if (changelogPath && existsSync(changelogPath)) {
    const extracted = extractChangelogNotes(readFileSync(changelogPath, 'utf8'), normalizedVersion);
    if (extracted) return extracted;
  }
  if (notesFile && existsSync(notesFile)) {
    const fileText = readFileSync(notesFile, 'utf8').trim();
    if (fileText) return fileText;
  }
  return `Grapher v${normalizedVersion}. See GitHub Releases and CHANGELOG.md for details.`;
}

export function discoverSignedUpdaterAssets(assetsDir, { version, repo, tag, pubkey = null }) {
  const resolvedDir = resolve(assetsDir);
  if (!existsSync(resolvedDir) || !statSync(resolvedDir).isDirectory()) {
    throw new Error(`Release assets directory does not exist: ${resolvedDir}`);
  }
  const normalizedVersion = normalizeVersion(version);
  const normalizedRepo = validateRepositorySlug(repo);
  const entries = readdirSync(resolvedDir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const sigFiles = entries.filter(name => name.endsWith('.sig'));
  const byTarget = new Map();

  for (const sigFile of sigFiles) {
    const assetFile = sigFile.slice(0, -'.sig'.length);
    const target = UPDATER_TARGETS.find(candidate => candidate.matchesAsset(assetFile));
    if (!target) {
      throw new Error(
        `Unrecognized Tauri updater signature file "${sigFile}" (payload "${assetFile}") in ${resolvedDir}.`,
      );
    }
    const versionedAssetMatch = assetFile.match(/^[^_]+_([^_]+)_/);
    if (versionedAssetMatch) {
      const filenameVersion = versionedAssetMatch[1].replace(/^v/i, '');
      if (filenameVersion !== normalizedVersion) {
        throw new Error(
          `Updater payload filename "${assetFile}" embeds version "${filenameVersion}", which does not match release version "${normalizedVersion}".`,
        );
      }
    }
    if (byTarget.has(target.id)) {
      throw new Error(
        `Multiple updater signatures found for target ${target.id}: ${byTarget.get(target.id).signatureFileName} and ${sigFile}.`,
      );
    }
    const assetPath = join(resolvedDir, assetFile);
    if (!existsSync(assetPath) || !statSync(assetPath).isFile() || statSync(assetPath).size === 0) {
      throw new Error(
        `Updater signature "${sigFile}" is missing a non-empty payload file "${assetFile}" in ${resolvedDir}.`,
      );
    }
    const rawSig = readFileSync(join(resolvedDir, sigFile), 'utf8');
    const signature = pubkey
      ? verifyMinisignSignatureAgainstPayload({
          payloadBytes: readFileSync(assetPath),
          signatureText: rawSig,
          pubkeyText: pubkey,
          expectedVersion: normalizedVersion,
          label: sigFile,
        }).signature
      : validateMinisignSignature(rawSig, normalizedVersion, sigFile);
    const url = buildReleaseDownloadUrl(normalizedRepo, tag, assetFile);
    byTarget.set(target.id, {
      targetId: target.id,
      assetFileName: assetFile,
      signatureFileName: sigFile,
      platformKeys: target.platformKeys,
      signature,
      url,
    });
  }

  return UPDATER_TARGETS.map(target => byTarget.get(target.id)).filter(Boolean);
}

/**
 * Validate a parsed static Tauri v2 `latest.json` manifest object before publishing
 * or in release contract tests.
 */
export function validateUpdaterManifestObject(
  manifest,
  { expectedVersion = null, requiredTargets = null } = {},
) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Updater manifest must be a JSON object.');
  }
  const version = normalizeVersion(manifest.version);
  if (expectedVersion && version !== normalizeVersion(expectedVersion)) {
    throw new Error(
      `Updater manifest version "${version}" does not match expected version "${normalizeVersion(expectedVersion)}".`,
    );
  }
  if (manifest.pub_date !== undefined) {
    validateRfc3339Date(manifest.pub_date);
  }
  if (manifest.notes !== undefined && typeof manifest.notes !== 'string') {
    throw new Error('Updater manifest `notes` must be a string.');
  }
  if (!manifest.platforms || typeof manifest.platforms !== 'object' || Array.isArray(manifest.platforms)) {
    throw new Error('Updater manifest must include a `platforms` object.');
  }

  const allowedKeys = new Map();
  for (const target of UPDATER_TARGETS) {
    for (const key of target.platformKeys) {
      allowedKeys.set(key, target);
    }
  }

  for (const [platformKey, entry] of Object.entries(manifest.platforms)) {
    const target = allowedKeys.get(platformKey);
    if (!target) {
      throw new Error(`Unsupported or unrecognized platform key "${platformKey}" in updater manifest.`);
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Platform entry "${platformKey}" must be an object with url and signature.`);
    }
    if (typeof entry.url !== 'string' || !entry.url.startsWith('https://')) {
      throw new Error(`Platform "${platformKey}" must use an https:// download URL.`);
    }
    let parsedUrl;
    try {
      parsedUrl = new URL(entry.url);
    } catch {
      throw new Error(`Platform "${platformKey}" has an invalid download URL "${entry.url}".`);
    }
    const assetName = decodeURIComponent(parsedUrl.pathname.split('/').pop() || '');
    if (!target.matchesAsset(assetName)) {
      throw new Error(
        `Platform "${platformKey}" points to incompatible artifact "${assetName}" (expected ${target.id} updater payload).`,
      );
    }
    validateMinisignSignature(entry.signature, version, `manifest.platforms["${platformKey}"].signature`);
  }

  if (Array.isArray(requiredTargets)) {
    for (const targetId of requiredTargets) {
      const target = UPDATER_TARGETS.find(candidate => candidate.id === targetId);
      if (!target) {
        throw new Error(`Unknown required updater target "${targetId}".`);
      }
      for (const key of target.platformKeys) {
        if (!manifest.platforms[key]) {
          throw new Error(
            `Updater manifest is missing required platform key "${key}" for target "${targetId}".`,
          );
        }
      }
    }
  }

  return manifest;
}

export function generateUpdaterManifest({
  assetsDir,
  outputPath = null,
  tag,
  version = null,
  repo = process.env.GITHUB_REPOSITORY || DEFAULT_GITHUB_REPOSITORY,
  notes = null,
  notesFile = null,
  changelogPath = null,
  pubDate = defaultPubDate(),
  pubkey = null,
  tauriConfPath = null,
  env = process.env,
  allowEmpty = false,
  requireAll = false,
  requireAllWhenSigned = false,
  requirePubkey = false,
  log = console.log,
  warn = console.warn,
} = {}) {
  const cleanedTag = String(tag ?? '').trim();
  if (!cleanedTag) {
    throw new Error('Release tag (--tag) is required.');
  }
  const tagVersion = normalizeVersion(cleanedTag);
  const resolvedVersion = version ? normalizeVersion(version) : tagVersion;
  if (resolvedVersion !== tagVersion) {
    throw new Error(
      `Release tag "${cleanedTag}" (version ${tagVersion}) does not match explicit version "${resolvedVersion}".`,
    );
  }
  const resolvedPubDate = validateRfc3339Date(pubDate);
  const resolvedRepo = validateRepositorySlug(repo);

  const explicitPubkey = typeof pubkey === 'string' ? pubkey.trim() : '';
  const effectivePubkey =
    explicitPubkey ||
    (tauriConfPath || requirePubkey
      ? resolveConfiguredUpdaterPubkey({ tauriConfPath, env })
      : null);

  if (effectivePubkey) {
    validateMinisignPublicKey(effectivePubkey);
  }

  const discovered = discoverSignedUpdaterAssets(assetsDir, {
    version: resolvedVersion,
    repo: resolvedRepo,
    tag: cleanedTag,
    pubkey: effectivePubkey,
  });

  const missingTargets = UPDATER_TARGETS
    .map(target => target.id)
    .filter(id => !discovered.some(item => item.targetId === id));

  if (requireAll && missingTargets.length > 0) {
    throw new Error(
      `Missing signed Tauri updater artifacts for required target(s): ${missingTargets.join(', ')}.`,
    );
  }

  if (discovered.length === 0 && !allowEmpty) {
    if (outputPath && existsSync(outputPath)) {
      rmSync(outputPath, { force: true });
    }
    log(
      `[desktop:updater-manifest] No signed Tauri updater artifacts (.sig) found in ${resolve(assetsDir)}; skipping latest.json generation.`,
    );
    return {
      written: false,
      skipped: true,
      reason: 'no-signed-artifacts',
      outputPath: outputPath ? resolve(outputPath) : null,
      manifest: null,
      targets: [],
    };
  }

  if (discovered.length > 0 && requirePubkey && !effectivePubkey) {
    throw new Error(
      `Refusing to generate latest.json: signed updater artifacts were found (${discovered.map(item => item.targetId).join(', ')}), but no matching updater public key is configured (set plugins.updater.pubkey in src-tauri/tauri.conf.json or GRAPHER_UPDATER_PUBKEY).`,
    );
  }

  if (discovered.length > 0 && missingTargets.length > 0) {
    if (requireAllWhenSigned) {
      throw new Error(
        `Refusing to generate partial latest.json: signed updater artifacts exist for ${discovered.map(item => item.targetId).join(', ')}, but required target(s) are missing: ${missingTargets.join(', ')}.`,
      );
    }
    warn(
      `[desktop:updater-manifest] Generating partial latest.json; missing signed updater artifacts for: ${missingTargets.join(', ')}.`,
    );
  }

  const platforms = {};
  for (const item of discovered) {
    for (const key of item.platformKeys) {
      platforms[key] = {
        signature: item.signature,
        url: item.url,
      };
    }
  }

  const manifest = {
    version: resolvedVersion,
    notes: resolveReleaseNotes({
      version: resolvedVersion,
      notes,
      notesFile,
      changelogPath,
    }),
    pub_date: resolvedPubDate,
    platforms,
  };

  validateUpdaterManifestObject(manifest, {
    expectedVersion: resolvedVersion,
    requiredTargets: discovered.map(item => item.targetId),
  });

  let resolvedOutput = null;
  if (outputPath) {
    resolvedOutput = resolve(outputPath);
    mkdirSync(dirname(resolvedOutput), { recursive: true });
    writeFileSync(resolvedOutput, `${JSON.stringify(manifest, null, 2)}\n`);
    log(
      `[desktop:updater-manifest] Wrote ${resolvedOutput} for v${resolvedVersion} (${Object.keys(platforms).length} platform key(s): ${Object.keys(platforms).join(', ') || 'none'}).`,
    );
  }

  return {
    written: Boolean(resolvedOutput),
    skipped: false,
    reason: null,
    outputPath: resolvedOutput,
    manifest,
    targets: discovered.map(item => item.targetId),
    verifiedPubkey: Boolean(effectivePubkey),
  };
}

/**
 * Finalize a GitHub Release assets directory after `latest.json` generation
 * and signature verification:
 * - Removes redundant per-file `*.sha256` files and standalone `*.sig` files
 *   (signatures are already embedded and verified in `latest.json`).
 * - Generates one consolidated, sorted `SHA256SUMS.txt` covering every
 *   downloadable installer and archive.
 */
export function consolidateReleaseAssets(
  assetsDir,
  {
    checksumFile = 'SHA256SUMS.txt',
    pruneSignatures = true,
    log = message => console.log(message),
  } = {},
) {
  const dir = resolve(assetsDir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`Release assets directory does not exist: ${dir}`);
  }
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const removed = [];
  const hashedFiles = [];
  for (const name of entries) {
    const fullPath = join(dir, name);
    if (name === checksumFile || name.endsWith('.sha256') || (pruneSignatures && name.endsWith('.sig'))) {
      rmSync(fullPath, { force: true });
      if (name !== checksumFile) removed.push(name);
      continue;
    }
    if (name === 'latest.json') continue;
    const digest = createHash('sha256').update(readFileSync(fullPath)).digest('hex');
    hashedFiles.push({ name, digest });
  }

  if (hashedFiles.length === 0) {
    throw new Error(`No downloadable release assets found in ${dir} to include in ${checksumFile}.`);
  }

  const checksumPath = join(dir, checksumFile);
  const content = `${hashedFiles.map(item => `${item.digest}  ${item.name}`).join('\n')}\n`;
  writeFileSync(checksumPath, content, 'utf8');
  log(
    `[desktop:updater-manifest] Wrote ${checksumFile} for ${hashedFiles.length} asset(s) and pruned ${removed.length} redundant .sha256/.sig file(s).`,
  );
  return {
    checksumPath,
    hashedFiles,
    removed,
    remainingFiles: readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b)),
  };
}

function parseCliArgs(argv) {
  const options = {
    finalizeAssets: false,
    assetsDir: null,
    outputPath: null,
    tag: process.env.RELEASE_TAG || null,
    version: null,
    repo: process.env.GITHUB_REPOSITORY || DEFAULT_GITHUB_REPOSITORY,
    notes: null,
    notesFile: null,
    changelogPath: null,
    pubDate: defaultPubDate(),
    pubkey: null,
    tauriConfPath: null,
    allowEmpty: false,
    requireAll: false,
    requireAllWhenSigned: false,
    requirePubkey: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--finalize-assets') {
      options.finalizeAssets = true;
    } else if (arg === '--assets-dir' && argv[i + 1]) {
      options.assetsDir = argv[++i];
    } else if (arg === '--output' && argv[i + 1]) {
      options.outputPath = argv[++i];
    } else if (arg === '--tag' && argv[i + 1]) {
      options.tag = argv[++i];
    } else if (arg === '--version' && argv[i + 1]) {
      options.version = argv[++i];
    } else if (arg === '--repo' && argv[i + 1]) {
      options.repo = argv[++i];
    } else if (arg === '--notes' && argv[i + 1]) {
      options.notes = argv[++i];
    } else if (arg === '--notes-file' && argv[i + 1]) {
      options.notesFile = argv[++i];
    } else if (arg === '--changelog' && argv[i + 1]) {
      options.changelogPath = argv[++i];
    } else if (arg === '--pub-date' && argv[i + 1]) {
      options.pubDate = argv[++i];
    } else if (arg === '--pubkey' && argv[i + 1]) {
      options.pubkey = argv[++i];
    } else if (arg === '--tauri-conf' && argv[i + 1]) {
      options.tauriConfPath = argv[++i];
    } else if (arg === '--allow-empty') {
      options.allowEmpty = true;
    } else if (arg === '--require-all') {
      options.requireAll = true;
    } else if (arg === '--require-all-when-signed') {
      options.requireAllWhenSigned = true;
    } else if (arg === '--require-pubkey') {
      options.requirePubkey = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage:\n' +
          '  node scripts/desktop-updater-manifest.mjs --assets-dir <dir> --output <latest.json> --tag <vX.Y.Z> [options]\n' +
          '  node scripts/desktop-updater-manifest.mjs --finalize-assets --assets-dir <dir>',
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.assetsDir) throw new Error('--assets-dir is required.');
  if (!options.finalizeAssets) {
    if (!options.outputPath) throw new Error('--output is required.');
    if (!options.tag) throw new Error('--tag is required.');
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    if (options.finalizeAssets) {
      consolidateReleaseAssets(options.assetsDir);
    } else {
      generateUpdaterManifest(options);
    }
  } catch (error) {
    console.error(`[desktop:updater-manifest] ${error.message}`);
    process.exitCode = 1;
  }
}
