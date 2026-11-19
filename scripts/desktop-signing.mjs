// Local & CI desktop signing helper and preflight verifier covering all three
// independent signing concerns without ever committing keys or printing secrets:
//   1. Tauri updater minisign keypair, signatures, and `latest.json` manifest
//   2. Optional macOS Developer ID application signing & notarization credentials
//   3. Optional Windows Authenticode / NSIS installer signing credentials
import { execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, scryptSync } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from './ensure-deps.mjs';
import {
  normalizeVersion,
  parseMinisignSignature,
  UPDATER_TARGETS,
  validateMinisignPublicKey,
  validateUpdaterManifestObject,
  verifyMinisignSignatureAgainstPayload,
} from './desktop-updater-manifest.mjs';

// ASN.1 DER PKCS#8 prefix for raw 32-byte Ed25519 private key seeds.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const PUBLIC_KEY_MARKER_RE = /minisign public key/i;
const SECRET_KEY_MARKER_RE =
  /PRIVATE KEY|encrypted secret key|unencrypted secret key|minisign secret key|rsign encrypted secret key/i;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const SHA1_HEX_RE = /^[0-9a-fA-F]{40}$/;

export const DEFAULT_WINDOWS_TIMESTAMP_URL = 'http://timestamp.digicert.com';

function tauriCliEntry(installationRoot = root) {
  const jsEntry = join(installationRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  if (existsSync(jsEntry)) {
    return { command: process.execPath, prefixArgs: [jsEntry] };
  }
  const binEntry = join(
    installationRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tauri.cmd' : 'tauri',
  );
  return { command: binEntry, prefixArgs: [] };
}

function isInsideDirectory(candidatePath, parentDir) {
  const rel = relative(resolve(parentDir), resolve(candidatePath));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/') && !/^[A-Za-z]:/.test(rel));
}

/**
 * Resolve the configured updater public key AND record where it came from,
 * matching the exact precedence of `src-tauri/src/lib.rs`:
 *   explicit override -> `GRAPHER_UPDATER_PUBKEY` -> `TAURI_UPDATER_PUBKEY` -> `tauri.conf.json`.
 */
export function resolveUpdaterPubkeySource({
  explicitPubkey = null,
  tauriConfPath = join(root, 'src-tauri', 'tauri.conf.json'),
  env = process.env,
} = {}) {
  const cleanedExplicit = typeof explicitPubkey === 'string' ? explicitPubkey.trim() : '';
  if (cleanedExplicit) {
    return { pubkey: cleanedExplicit, source: 'cli' };
  }
  const envPrimary =
    typeof env?.GRAPHER_UPDATER_PUBKEY === 'string' ? env.GRAPHER_UPDATER_PUBKEY.trim() : '';
  if (envPrimary) {
    return { pubkey: envPrimary, source: 'GRAPHER_UPDATER_PUBKEY' };
  }
  const envFallback =
    typeof env?.TAURI_UPDATER_PUBKEY === 'string' ? env.TAURI_UPDATER_PUBKEY.trim() : '';
  if (envFallback) {
    return { pubkey: envFallback, source: 'TAURI_UPDATER_PUBKEY' };
  }
  if (tauriConfPath && existsSync(tauriConfPath)) {
    const conf = JSON.parse(readFileSync(tauriConfPath, 'utf8'));
    const configured =
      typeof conf?.plugins?.updater?.pubkey === 'string'
        ? conf.plugins.updater.pubkey.trim()
        : '';
    if (configured) {
      return { pubkey: configured, source: 'tauri.conf.json' };
    }
  }
  return { pubkey: null, source: 'none' };
}

/**
 * Load a public key either from an inline string or from a file path if it points to an existing file.
 */
export function readPubkeyInput(pubkeyOrPath) {
  const trimmed = String(pubkeyOrPath ?? '').trim();
  if (!trimmed) {
    throw new Error('Updater public key input is empty.');
  }
  if (existsSync(trimmed) && statSync(trimmed).isFile()) {
    return readFileSync(trimmed, 'utf8').trim();
  }
  return trimmed;
}

/**
 * Validate a Tauri minisign public key with clear diagnostics for common mistakes
 * (such as pasting a raw 2-line `.pub` file instead of the base64 string, or
 * pasting a private key into the public-key slot). Never includes key contents in errors.
 */
export function validateUpdaterPublicKeyStrict(pubkeyText, label = 'updater public key') {
  const trimmed = String(pubkeyText ?? '').trim();
  if (!trimmed) {
    throw new Error(`Configured ${label} is empty.`);
  }
  if (SECRET_KEY_MARKER_RE.test(trimmed)) {
    throw new Error(
      `Refusing to accept private/secret key material in ${label}. Use the companion .pub public key instead.`,
    );
  }
  if (/^untrusted comment:/i.test(trimmed)) {
    throw new Error(
      `Configured ${label} appears to be raw 2-line minisign text rather than the base64-encoded public key string expected by Tauri. Base64-encode the .pub file (or use the exact output of "npm run desktop:signing -- generate").`,
    );
  }
  return validateMinisignPublicKey(trimmed, label);
}

/**
 * Resolve private signing key material from explicit CLI path or env vars
 * (`TAURI_SIGNING_PRIVATE_KEY` or `TAURI_SIGNING_PRIVATE_KEY_PATH`).
 * Never returns or logs raw key text in public reports.
 */
export function resolveUpdaterPrivateKeyInput({
  privateKeyPath = null,
  env = process.env,
} = {}) {
  const explicitPath = typeof privateKeyPath === 'string' ? privateKeyPath.trim() : '';
  if (explicitPath) {
    if (!existsSync(explicitPath) || !statSync(explicitPath).isFile()) {
      throw new Error(`Specified private key file does not exist: ${explicitPath}`);
    }
    const content = readFileSync(explicitPath, 'utf8').trim();
    if (!content) {
      throw new Error(`Specified private key file is empty: ${explicitPath}`);
    }
    return { source: 'file', filePath: resolve(explicitPath), content };
  }

  const rawEnvKey =
    typeof env?.TAURI_SIGNING_PRIVATE_KEY === 'string' ? env.TAURI_SIGNING_PRIVATE_KEY.trim() : '';
  if (rawEnvKey) {
    // Tauri CLI supports either raw/base64 key contents or a filesystem path in TAURI_SIGNING_PRIVATE_KEY.
    if (
      !rawEnvKey.includes('\n') &&
      rawEnvKey.length < 260 &&
      existsSync(rawEnvKey) &&
      statSync(rawEnvKey).isFile()
    ) {
      const content = readFileSync(rawEnvKey, 'utf8').trim();
      if (!content) {
        throw new Error('Private key file referenced by TAURI_SIGNING_PRIVATE_KEY is empty.');
      }
      return { source: 'TAURI_SIGNING_PRIVATE_KEY(path)', filePath: resolve(rawEnvKey), content };
    }
    return { source: 'TAURI_SIGNING_PRIVATE_KEY', filePath: null, content: rawEnvKey };
  }

  const envPath =
    typeof env?.TAURI_SIGNING_PRIVATE_KEY_PATH === 'string'
      ? env.TAURI_SIGNING_PRIVATE_KEY_PATH.trim()
      : '';
  if (envPath) {
    if (!existsSync(envPath) || !statSync(envPath).isFile()) {
      throw new Error(
        `TAURI_SIGNING_PRIVATE_KEY_PATH is set, but the file does not exist: ${envPath}`,
      );
    }
    const content = readFileSync(envPath, 'utf8').trim();
    if (!content) {
      throw new Error(`TAURI_SIGNING_PRIVATE_KEY_PATH points to an empty file: ${envPath}`);
    }
    return { source: 'TAURI_SIGNING_PRIVATE_KEY_PATH', filePath: resolve(envPath), content };
  }

  return null;
}

function decodeMinisignSecretKeyLines(secretKeyText) {
  const trimmed = String(secretKeyText ?? '').trim();
  if (!trimmed) {
    throw new Error('TAURI_SIGNING_PRIVATE_KEY is empty.');
  }

  let decoded = trimmed;
  if (!trimmed.startsWith('untrusted comment:')) {
    const compact = trimmed.replace(/\s+/g, '');
    if (compact.length % 4 !== 0 || !BASE64_RE.test(compact)) {
      throw new Error(
        'TAURI_SIGNING_PRIVATE_KEY is neither a valid raw minisign secret key nor valid base64-encoded key data.',
      );
    }
    decoded = Buffer.from(compact, 'base64').toString('utf8');
  }

  if (PUBLIC_KEY_MARKER_RE.test(decoded) && !SECRET_KEY_MARKER_RE.test(decoded)) {
    throw new Error(
      'TAURI_SIGNING_PRIVATE_KEY appears to contain a minisign PUBLIC key instead of a private signing key.',
    );
  }

  const lines = decoded
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(line => line.length > 0);
  if (lines.length !== 2 || !lines[0].startsWith('untrusted comment:') || !BASE64_RE.test(lines[1])) {
    throw new Error(
      'TAURI_SIGNING_PRIVATE_KEY does not decode to a valid 2-line minisign secret key.',
    );
  }

  const raw = Buffer.from(lines[1], 'base64');
  if (raw.length !== 158) {
    throw new Error(
      `TAURI_SIGNING_PRIVATE_KEY payload has unexpected length (${raw.length} bytes; expected 158-byte Ed25519 minisign secret key).`,
    );
  }
  const sigAlg = raw.subarray(0, 2).toString('ascii');
  if (sigAlg !== 'Ed') {
    throw new Error(
      `TAURI_SIGNING_PRIVATE_KEY uses unsupported signature algorithm (expected Ed25519 "Ed").`,
    );
  }
  const kdfAlg = raw.subarray(2, 4);
  const kdfName = kdfAlg.toString('ascii');
  const isEncrypted = kdfName === 'Sc';
  const isUnencrypted = kdfAlg[0] === 0 && kdfAlg[1] === 0;
  if (!isEncrypted && !isUnencrypted) {
    throw new Error('TAURI_SIGNING_PRIVATE_KEY uses an unsupported KDF algorithm.');
  }

  return {
    raw,
    sigAlg,
    isEncrypted,
    salt: raw.subarray(6, 38),
    opslimit: Number(raw.readBigUInt64LE(38)),
    memlimit: Number(raw.readBigUInt64LE(46)),
    encBox: raw.subarray(54, 158),
  };
}

function resolveScryptParams(opslimit, memlimit) {
  const r = 8;
  let p = 1;
  let N = 1;
  if (opslimit < memlimit / 32) {
    const maxN = Math.floor(opslimit / (4 * r));
    while (N * 2 <= maxN) N *= 2;
  } else {
    const maxN = Math.floor(memlimit / (128 * r));
    while (N * 2 <= maxN) N *= 2;
    p = Math.max(1, Math.floor(opslimit / (4 * r * N)));
  }
  return { N, r, p };
}

/**
 * Derive the exact Tauri base64-encoded minisign public key and Key ID from a
 * minisign secret key (supporting both unencrypted and scrypt-encrypted keys).
 * Uses Ed25519 public-key re-derivation from the decrypted 32-byte seed to prove
 * both key integrity and passphrase correctness without ever revealing secret bytes.
 */
export function derivePublicKeyFromMinisignSecretKey(secretKeyText, password = '') {
  const parsed = decodeMinisignSecretKeyLines(secretKeyText);
  const normalizedPassword = typeof password === 'string' ? password : '';

  let plain;
  if (parsed.isEncrypted) {
    const { N, r, p } = resolveScryptParams(parsed.opslimit, parsed.memlimit);
    const neededMem = 128 * r * N;
    // Guard against absurdly large scrypt parameters from corrupted input (> 1.5 GiB).
    if (!Number.isFinite(neededMem) || neededMem <= 0 || neededMem > 1_610_612_736) {
      throw new Error(
        'TAURI_SIGNING_PRIVATE_KEY specifies unsupported scrypt memory parameters (key may be corrupted).',
      );
    }
    const stream = scryptSync(normalizedPassword, parsed.salt, 104, {
      N,
      r,
      p,
      maxmem: Math.max(parsed.memlimit * 2, neededMem * 2),
    });
    plain = Buffer.alloc(104);
    for (let i = 0; i < 104; i++) {
      plain[i] = parsed.encBox[i] ^ stream[i];
    }
  } else {
    plain = Buffer.from(parsed.encBox);
  }

  try {
    const keyId = Buffer.from(plain.subarray(0, 8));
    const seed = plain.subarray(8, 40);
    const embeddedPubkey = Buffer.from(plain.subarray(40, 72));

    let derivedPubkey;
    try {
      const privObj = createPrivateKey({
        key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
        format: 'der',
        type: 'pkcs8',
      });
      derivedPubkey = createPublicKey(privObj).export({ format: 'der', type: 'spki' }).subarray(-32);
    } catch {
      throw new Error(
        'Failed to decrypt TAURI_SIGNING_PRIVATE_KEY. Verify TAURI_SIGNING_PRIVATE_KEY_PASSWORD matches the key passphrase (or is unset for password-less keys).',
      );
    }

    if (!derivedPubkey.equals(embeddedPubkey)) {
      throw new Error(
        'Failed to decrypt TAURI_SIGNING_PRIVATE_KEY: wrong TAURI_SIGNING_PRIVATE_KEY_PASSWORD or corrupted private key.',
      );
    }

    const pubBin = Buffer.concat([Buffer.from(parsed.sigAlg, 'ascii'), keyId, embeddedPubkey]);
    const displayKeyIdHex = Buffer.from(keyId).reverse().toString('hex').toUpperCase();
    const pubText = `untrusted comment: minisign public key: ${displayKeyIdHex}\n${pubBin.toString('base64')}\n`;
    const compact = Buffer.from(pubText, 'utf8').toString('base64');
    const validated = validateMinisignPublicKey(compact, 'derived updater public key');
    return {
      pubkey: validated.compact,
      keyId: validated.keyId,
      keyIdHex: validated.keyIdHex,
      displayKeyIdHex,
      rawEd25519: embeddedPubkey,
      encrypted: parsed.isEncrypted,
    };
  } finally {
    // Best-effort zeroization of decrypted private key buffer in memory.
    plain.fill(0);
  }
}

/**
 * Cryptographically compare a private key against a configured Tauri minisign public key
 * (comparing both the 8-byte Key ID and the 32-byte Ed25519 public key material, regardless
 * of any untrusted comment differences).
 */
export function assertPrivateKeyMatchesPubkey({
  secretKeyText,
  password = '',
  configuredPubkey,
  configuredSource = 'configured updater public key',
}) {
  const parsedConfigured = validateUpdaterPublicKeyStrict(configuredPubkey, configuredSource);
  const derived = derivePublicKeyFromMinisignSecretKey(secretKeyText, password);

  const configuredDer = parsedConfigured.publicKeyObject.export({ format: 'der', type: 'spki' });
  const configuredRawEd25519 = configuredDer.subarray(-32);

  if (!derived.keyId.equals(parsedConfigured.keyId) || !derived.rawEd25519.equals(configuredRawEd25519)) {
    throw new Error(
      `Tauri updater signing keypair mismatch: TAURI_SIGNING_PRIVATE_KEY derives key ID ${derived.keyIdHex}, but ${configuredSource} has key ID ${parsedConfigured.keyIdHex}. Update GRAPHER_UPDATER_PUBKEY (GitHub Actions Variable) or src-tauri/tauri.conf.json plugins.updater.pubkey so both belong to the same keypair.`,
    );
  }

  return {
    pubkey: parsedConfigured.compact,
    derivedPubkey: derived.pubkey,
    keyIdHex: parsedConfigured.keyIdHex,
    displayKeyIdHex: derived.displayKeyIdHex,
    encrypted: derived.encrypted,
  };
}

/**
 * Generate a new Tauri minisign keypair using `@tauri-apps/cli` without printing
 * private key material to stdout or stderr. Refuses to write inside the repository
 * working tree unless `allowInRepo: true` is explicitly passed.
 */
export function generateMinisignKeypair({
  outputPath,
  password = '',
  force = false,
  allowInRepo = false,
  repoRoot = root,
} = {}) {
  const resolvedOut = resolve(String(outputPath ?? '').trim());
  if (!outputPath || !String(outputPath).trim()) {
    throw new Error('--output <path> is required when generating a minisign keypair.');
  }
  if (!allowInRepo && isInsideDirectory(resolvedOut, repoRoot)) {
    throw new Error(
      `Refusing to write private signing key inside the repository (${resolvedOut}). Choose an offline path outside the repo (for example ~/.tauri/grapher-updater.key) or pass --allow-in-repo for temporary tests.`,
    );
  }
  const pubPath = `${resolvedOut}.pub`;
  if (!force && (existsSync(resolvedOut) || existsSync(pubPath))) {
    throw new Error(
      `Refusing to overwrite existing key file(s) at ${resolvedOut} / ${pubPath}. Pass --force to replace them.`,
    );
  }

  mkdirSync(dirname(resolvedOut), { recursive: true });
  const { command, prefixArgs } = tauriCliEntry(repoRoot);
  const cliArgs = ['signer', 'generate', '-w', resolvedOut];
  if (force) cliArgs.push('--force');
  if (password) {
    cliArgs.push('-p', password);
  } else {
    cliArgs.push('--ci');
  }

  try {
    execFileSync(command, [...prefixArgs, ...cliArgs], {
      cwd: repoRoot,
      stdio: 'pipe',
      encoding: 'utf8',
    });
  } catch (error) {
    throw new Error(
      `Failed to generate Tauri minisign keypair via @tauri-apps/cli (exit status ${error.status ?? 'unknown'}).`,
    );
  }

  if (process.platform !== 'win32') {
    chmodSync(resolvedOut, 0o600);
  }

  const secretKeyText = readFileSync(resolvedOut, 'utf8');
  const publicKeyText = readFileSync(pubPath, 'utf8').trim();
  const matched = assertPrivateKeyMatchesPubkey({
    secretKeyText,
    password,
    configuredPubkey: publicKeyText,
    configuredSource: basename(pubPath),
  });

  return {
    privateKeyPath: resolvedOut,
    publicKeyPath: pubPath,
    pubkey: matched.pubkey,
    keyIdHex: matched.keyIdHex,
    displayKeyIdHex: matched.displayKeyIdHex,
  };
}

/**
 * Inspect optional macOS Developer ID signing & notarization environment without exposing secret values.
 */
export function inspectMacosSigningEnv(env = process.env) {
  const has = key => typeof env?.[key] === 'string' && env[key].trim().length > 0;
  const hasCert = has('APPLE_CERTIFICATE');
  const hasCertPassword = has('APPLE_CERTIFICATE_PASSWORD');
  const hasIdentity = has('APPLE_SIGNING_IDENTITY');
  const identityValue = hasIdentity ? env.APPLE_SIGNING_IDENTITY.trim() : null;
  const isNonAdhocIdentity = Boolean(identityValue && identityValue !== '-');

  let codeSigningStatus = 'ad-hoc';
  const missingCodeSigning = [];
  if (hasCert || hasCertPassword || isNonAdhocIdentity) {
    if (hasCert && hasCertPassword && isNonAdhocIdentity) {
      codeSigningStatus = 'configured-ci-p12';
    } else if (!hasCert && !hasCertPassword && isNonAdhocIdentity) {
      // Local macOS developer keychain signing using an already-installed Developer ID identity.
      codeSigningStatus = 'configured-local-identity';
    } else {
      codeSigningStatus = 'partial';
      if (!hasCert) missingCodeSigning.push('APPLE_CERTIFICATE');
      if (!hasCertPassword) missingCodeSigning.push('APPLE_CERTIFICATE_PASSWORD');
      if (!isNonAdhocIdentity) missingCodeSigning.push('APPLE_SIGNING_IDENTITY');
    }
  }

  const hasApiKey = has('APPLE_API_KEY');
  const hasApiIssuer = has('APPLE_API_ISSUER');
  const hasApiKeyP8 = has('APPLE_API_KEY_P8');
  const hasApiKeyPath = has('APPLE_API_KEY_PATH') && existsSync(env.APPLE_API_KEY_PATH.trim());

  const hasAppleId = has('APPLE_ID');
  const hasApplePassword = has('APPLE_PASSWORD');
  const hasAppleTeamId = has('APPLE_TEAM_ID');

  let notarizationStatus = 'skipped';
  let notarizationMode = null;
  const missingNotarization = [];

  if (hasApiKey && hasApiIssuer && (hasApiKeyP8 || hasApiKeyPath)) {
    notarizationStatus = codeSigningStatus.startsWith('configured')
      ? 'configured-api-key'
      : 'requires-developer-id';
    notarizationMode = 'api-key';
  } else if (hasAppleId && hasApplePassword && hasAppleTeamId) {
    notarizationStatus = codeSigningStatus.startsWith('configured')
      ? 'configured-apple-id'
      : 'requires-developer-id';
    notarizationMode = 'apple-id';
  } else if (hasApiKey || hasApiIssuer || hasApiKeyP8 || hasApiKeyPath) {
    notarizationStatus = 'partial';
    if (!hasApiKey) missingNotarization.push('APPLE_API_KEY');
    if (!hasApiIssuer) missingNotarization.push('APPLE_API_ISSUER');
    if (!hasApiKeyP8 && !hasApiKeyPath) missingNotarization.push('APPLE_API_KEY_P8');
  } else if (hasAppleId || hasApplePassword || hasAppleTeamId) {
    notarizationStatus = 'partial';
    if (!hasAppleId) missingNotarization.push('APPLE_ID');
    if (!hasApplePassword) missingNotarization.push('APPLE_PASSWORD');
    if (!hasAppleTeamId) missingNotarization.push('APPLE_TEAM_ID');
  }

  const warnings = [];
  if (codeSigningStatus === 'partial') {
    warnings.push(
      `Partial macOS Developer ID secrets configured; missing: ${missingCodeSigning.join(', ')}. Falling back to ad-hoc signing (Gatekeeper warnings expected on downloaded builds).`,
    );
  }
  if (notarizationStatus === 'partial') {
    warnings.push(
      `Partial macOS notarization credentials configured; missing: ${missingNotarization.join(', ')}. Notarization will be skipped.`,
    );
  } else if (notarizationStatus === 'requires-developer-id') {
    warnings.push(
      'macOS notarization credentials are set, but Developer ID signing is not configured; notarization requires Developer ID signing and will be skipped.',
    );
  }

  return {
    codeSigningStatus,
    notarizationStatus,
    notarizationMode,
    missingCodeSigning,
    missingNotarization,
    warnings,
  };
}

/**
 * Inspect optional Windows Authenticode signing configuration without exposing secret values.
 */
export function inspectWindowsSigningEnv(env = process.env) {
  const has = key => typeof env?.[key] === 'string' && env[key].trim().length > 0;
  const hasPfx = has('WINDOWS_CERTIFICATE');
  const hasPfxPassword = has('WINDOWS_CERTIFICATE_PASSWORD');
  const rawThumbprint = has('WINDOWS_CERTIFICATE_THUMBPRINT')
    ? env.WINDOWS_CERTIFICATE_THUMBPRINT.trim().replace(/[\s:]+/g, '')
    : '';
  const signCommand = has('WINDOWS_SIGN_COMMAND') ? env.WINDOWS_SIGN_COMMAND.trim() : '';
  const timestampUrl = has('WINDOWS_TIMESTAMP_URL')
    ? env.WINDOWS_TIMESTAMP_URL.trim()
    : DEFAULT_WINDOWS_TIMESTAMP_URL;

  const warnings = [];
  const errors = [];
  const missing = [];

  if (timestampUrl) {
    try {
      const parsed = new URL(timestampUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        errors.push('WINDOWS_TIMESTAMP_URL must use http:// or https://.');
      }
    } catch {
      errors.push('WINDOWS_TIMESTAMP_URL is not a valid URL.');
    }
  }

  if (signCommand) {
    if (!signCommand.includes('%1')) {
      errors.push(
        'WINDOWS_SIGN_COMMAND must include the "%1" placeholder for the target binary path (per Tauri bundle.windows.signCommand).',
      );
    }
    return {
      status: errors.length > 0 ? 'invalid' : 'configured-sign-command',
      mode: 'sign-command',
      thumbprintPreview: null,
      timestampUrl,
      missing,
      warnings,
      errors,
    };
  }

  if (rawThumbprint) {
    if (!SHA1_HEX_RE.test(rawThumbprint)) {
      errors.push(
        'WINDOWS_CERTIFICATE_THUMBPRINT must be a 40-character hexadecimal SHA-1 thumbprint.',
      );
    }
    return {
      status: errors.length > 0 ? 'invalid' : 'configured-thumbprint',
      mode: 'thumbprint',
      thumbprintPreview: SHA1_HEX_RE.test(rawThumbprint)
        ? `${rawThumbprint.slice(0, 8).toUpperCase()}...${rawThumbprint.slice(-4).toUpperCase()}`
        : null,
      timestampUrl,
      missing,
      warnings,
      errors,
    };
  }

  if (hasPfx || hasPfxPassword) {
    if (hasPfx && hasPfxPassword) {
      const compact = env.WINDOWS_CERTIFICATE.replace(/\s+/g, '');
      if (compact.length % 4 !== 0 || !BASE64_RE.test(compact)) {
        errors.push('WINDOWS_CERTIFICATE is not valid base64-encoded .pfx/.p12 certificate data.');
      }
      return {
        status: errors.length > 0 ? 'invalid' : 'configured-pfx',
        mode: 'pfx',
        thumbprintPreview: null,
        timestampUrl,
        missing,
        warnings,
        errors,
      };
    }
    if (!hasPfx) missing.push('WINDOWS_CERTIFICATE');
    if (!hasPfxPassword) missing.push('WINDOWS_CERTIFICATE_PASSWORD');
    warnings.push(
      `Partial Windows Authenticode secrets configured; missing: ${missing.join(', ')}. Installer will be unsigned (Windows SmartScreen warnings expected).`,
    );
    return {
      status: 'partial',
      mode: null,
      thumbprintPreview: null,
      timestampUrl,
      missing,
      warnings,
      errors,
    };
  }

  return {
    status: 'unsigned',
    mode: null,
    thumbprintPreview: null,
    timestampUrl,
    missing,
    warnings,
    errors,
  };
}

/**
 * Validate Tauri updater minisign configuration (public key + optional private key +
 * cryptographic match check) for local dry-runs, `desktop-build.mjs`, and CI preflight.
 */
export function validateUpdaterSigningEnvironment({
  env = process.env,
  tauriConfPath = join(root, 'src-tauri', 'tauri.conf.json'),
  explicitPubkey = null,
  privateKeyPath = null,
  requireSigning = false,
} = {}) {
  const pubkeyResolved = resolveUpdaterPubkeySource({ explicitPubkey, tauriConfPath, env });
  const parsedPubkey = pubkeyResolved.pubkey
    ? validateUpdaterPublicKeyStrict(
        pubkeyResolved.pubkey,
        pubkeyResolved.source === 'tauri.conf.json'
          ? 'plugins.updater.pubkey in src-tauri/tauri.conf.json'
          : pubkeyResolved.source,
      )
    : null;

  const privateKeyInput = resolveUpdaterPrivateKeyInput({ privateKeyPath, env });
  const signingEnabled = Boolean(privateKeyInput);

  if (requireSigning && !signingEnabled) {
    throw new Error(
      'Updater signing was required, but TAURI_SIGNING_PRIVATE_KEY (or TAURI_SIGNING_PRIVATE_KEY_PATH) is not configured.',
    );
  }

  if (signingEnabled && !parsedPubkey) {
    throw new Error(
      'TAURI_SIGNING_PRIVATE_KEY is set, but no updater public key is configured. Set the GRAPHER_UPDATER_PUBKEY GitHub Actions Variable (not a Secret) or plugins.updater.pubkey in src-tauri/tauri.conf.json to the matching base64 minisign public key.',
    );
  }

  let matchedKeypair = null;
  if (signingEnabled && parsedPubkey) {
    const password =
      typeof env?.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === 'string'
        ? env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD
        : '';
    matchedKeypair = assertPrivateKeyMatchesPubkey({
      secretKeyText: privateKeyInput.content,
      password,
      configuredPubkey: parsedPubkey.compact,
      configuredSource: pubkeyResolved.source,
    });
  }

  return {
    signingEnabled,
    mode: signingEnabled ? 'signed' : 'unsigned-installer-only',
    pubkey: parsedPubkey?.compact ?? null,
    pubkeySource: pubkeyResolved.source,
    keyIdHex: parsedPubkey?.keyIdHex ?? null,
    displayKeyIdHex: matchedKeypair?.displayKeyIdHex ?? null,
    privateKeySource: privateKeyInput?.source ?? null,
    keypairVerified: Boolean(matchedKeypair),
  };
}

/**
 * Run a complete preflight check across all three independent signing concerns.
 */
export function runSigningPreflight({
  env = process.env,
  tauriConfPath = join(root, 'src-tauri', 'tauri.conf.json'),
  explicitPubkey = null,
  privateKeyPath = null,
  target = null,
  requireUpdaterSigning = false,
  strictNative = false,
} = {}) {
  const updater = validateUpdaterSigningEnvironment({
    env,
    tauriConfPath,
    explicitPubkey,
    privateKeyPath,
    requireSigning: requireUpdaterSigning,
  });
  const macos = inspectMacosSigningEnv(env);
  const windows = inspectWindowsSigningEnv(env);

  const relevantNativeErrors = [];
  const relevantWarnings = [];
  if (!target || target.startsWith('macos')) {
    relevantWarnings.push(...macos.warnings);
  }
  if (!target || target.startsWith('windows')) {
    relevantWarnings.push(...windows.warnings);
    relevantNativeErrors.push(...windows.errors);
  }
  if (strictNative && relevantWarnings.length > 0) {
    relevantNativeErrors.push(...relevantWarnings);
  }
  if (relevantNativeErrors.length > 0) {
    throw new Error(relevantNativeErrors.join(' '));
  }

  return {
    target: target ?? 'all',
    updater,
    macos,
    windows,
    warnings: relevantWarnings,
  };
}

/**
 * Verify a standalone `.sig` file against its payload and the expected minisign public key.
 */
export function verifyArtifactSignatureFile({
  artifactPath,
  sigPath = `${artifactPath}.sig`,
  pubkey = null,
  tauriConfPath = join(root, 'src-tauri', 'tauri.conf.json'),
  env = process.env,
  expectedVersion = null,
} = {}) {
  const resolvedArtifact = resolve(artifactPath);
  const resolvedSig = resolve(sigPath);
  if (!existsSync(resolvedArtifact) || !statSync(resolvedArtifact).isFile()) {
    throw new Error(`Updater payload file not found: ${resolvedArtifact}`);
  }
  if (!existsSync(resolvedSig) || !statSync(resolvedSig).isFile()) {
    throw new Error(`Updater signature file not found: ${resolvedSig}`);
  }
  const effectivePubkey = pubkey
    ? readPubkeyInput(pubkey)
    : resolveUpdaterPubkeySource({ tauriConfPath, env }).pubkey;
  if (!effectivePubkey) {
    throw new Error(
      'No updater public key provided or configured. Pass --pubkey <base64|path>, set GRAPHER_UPDATER_PUBKEY, or configure plugins.updater.pubkey in src-tauri/tauri.conf.json.',
    );
  }
  validateUpdaterPublicKeyStrict(effectivePubkey);
  return verifyMinisignSignatureAgainstPayload({
    payloadBytes: readFileSync(resolvedArtifact),
    signatureText: readFileSync(resolvedSig, 'utf8'),
    pubkeyText: effectivePubkey,
    expectedVersion: expectedVersion ? normalizeVersion(expectedVersion) : null,
    label: basename(resolvedSig),
  });
}

/**
 * Verify a `latest.json` manifest (structure, platform keys, HTTPS URLs, signature formats,
 * version binding) and optionally cryptographically verify every platform entry against
 * local payload files in `assetsDir` and the configured/explicit public key.
 */
export function verifyUpdaterManifestFile({
  manifestPath,
  assetsDir = null,
  pubkey = null,
  tauriConfPath = join(root, 'src-tauri', 'tauri.conf.json'),
  env = process.env,
  expectedVersion = null,
  requireAll = false,
} = {}) {
  const resolvedManifest = resolve(manifestPath);
  if (!existsSync(resolvedManifest) || !statSync(resolvedManifest).isFile()) {
    throw new Error(`Updater manifest file not found: ${resolvedManifest}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(resolvedManifest, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to parse updater manifest JSON at ${resolvedManifest}: ${error.message}`);
  }

  const normalizedExpected = expectedVersion ? normalizeVersion(expectedVersion) : null;
  validateUpdaterManifestObject(manifest, {
    expectedVersion: normalizedExpected,
    requiredTargets: requireAll ? UPDATER_TARGETS.map(target => target.id) : null,
  });

  const effectivePubkey = pubkey
    ? readPubkeyInput(pubkey)
    : resolveUpdaterPubkeySource({ tauriConfPath, env }).pubkey;
  const parsedPubkey = effectivePubkey ? validateUpdaterPublicKeyStrict(effectivePubkey) : null;

  const verifiedPlatforms = [];
  const entries = Object.entries(manifest.platforms ?? {});
  for (const [platformKey, entry] of entries) {
    const parsedSig = parseMinisignSignature(
      entry.signature,
      manifest.version,
      `manifest.platforms["${platformKey}"].signature`,
    );
    if (parsedPubkey && !parsedSig.keyId.equals(parsedPubkey.keyId)) {
      throw new Error(
        `Manifest platform "${platformKey}" was signed with key ID ${parsedSig.keyIdHex}, which does not match configured public key ID ${parsedPubkey.keyIdHex}.`,
      );
    }

    let payloadVerified = false;
    if (assetsDir) {
      if (!parsedPubkey) {
        throw new Error(
          'Cannot cryptographically verify manifest payloads in --assets-dir without a configured or explicit --pubkey.',
        );
      }
      const parsedUrl = new URL(entry.url);
      const assetFile = decodeURIComponent(parsedUrl.pathname.split('/').pop() || '');
      const assetPath = join(resolve(assetsDir), assetFile);
      if (!existsSync(assetPath) || !statSync(assetPath).isFile()) {
        throw new Error(
          `Manifest platform "${platformKey}" references "${assetFile}", which was not found in ${resolve(assetsDir)}.`,
        );
      }
      verifyMinisignSignatureAgainstPayload({
        payloadBytes: readFileSync(assetPath),
        signatureText: entry.signature,
        pubkeyText: parsedPubkey.compact,
        expectedVersion: manifest.version,
        label: `manifest.platforms["${platformKey}"] (${assetFile})`,
      });
      payloadVerified = true;
    }

    verifiedPlatforms.push({
      platformKey,
      keyIdHex: parsedSig.keyIdHex,
      signedVersion: parsedSig.signedVersion,
      payloadVerified,
    });
  }

  return {
    manifestPath: resolvedManifest,
    version: manifest.version,
    pubkeyKeyIdHex: parsedPubkey?.keyIdHex ?? null,
    platformCount: verifiedPlatforms.length,
    payloadsVerified: Boolean(assetsDir),
    platforms: verifiedPlatforms,
  };
}

function formatPreflightReport(report) {
  const lines = [];
  const u = report.updater;
  lines.push(`[desktop:signing] Target scope: ${report.target}`);
  if (u.signingEnabled) {
    lines.push(
      `[desktop:signing] (1) Tauri updater minisign: SIGNED (key ID ${u.keyIdHex}, pubkey source: ${u.pubkeySource}, private key matches public key)`,
    );
  } else {
    const pubDetail = u.keyIdHex
      ? `pubkey embedded: ${u.keyIdHex} from ${u.pubkeySource}`
      : 'no pubkey embedded';
    lines.push(
      `[desktop:signing] (1) Tauri updater minisign: UNSIGNED installer-only (${pubDetail}; TAURI_SIGNING_PRIVATE_KEY unset)`,
    );
  }

  if (report.target === 'all' || report.target.startsWith('macos')) {
    const m = report.macos;
    lines.push(
      `[desktop:signing] (2) macOS Developer ID & notarization: signing=${m.codeSigningStatus}, notarization=${m.notarizationStatus}`,
    );
  }
  if (report.target === 'all' || report.target.startsWith('windows')) {
    const w = report.windows;
    const thumb = w.thumbprintPreview ? ` (${w.thumbprintPreview})` : '';
    lines.push(
      `[desktop:signing] (3) Windows Authenticode: status=${w.status}${thumb}, timestamp=${w.timestampUrl}`,
    );
  }
  return lines.join('\n');
}

function printHelp() {
  console.log(`Usage: node scripts/desktop-signing.mjs <command> [options]

Commands:
  generate --output <path> [--password <pw>] [--force] [--allow-in-repo]
      Generate a Tauri minisign keypair offline (private key chmod 0600, never printed).

  derive-pubkey [--private-key <path>] [--tauri-conf <path>] [--check-configured] [--json]
      Derive the base64 minisign public key & Key ID from a private key (env or file),
      and optionally assert it matches the public key configured for the app.

  check [--target <macos-arm64|macos-x64|windows-x64>] [--tauri-conf <path>]
        [--pubkey <base64|path>] [--private-key <path>] [--require-updater-signing]
        [--strict-native] [--json]
      Preflight-validate all three signing concerns (Tauri updater minisign keypair match,
      optional macOS Developer ID/notarization, optional Windows Authenticode).

  verify-signature --artifact <path> [--sig <path>] [--pubkey <base64|path>]
                   [--tauri-conf <path>] [--version <X.Y.Z>]
      Cryptographically verify a minisign .sig file against its payload & public key.

  verify-manifest --manifest <latest.json> [--assets-dir <dir>] [--pubkey <base64|path>]
                  [--tauri-conf <path>] [--tag <vX.Y.Z> | --version <X.Y.Z>] [--require-all]
      Validate latest.json schema, version binding, and (with --assets-dir) payload signatures.
`);
}

function parseFlagValue(argv, index, flag) {
  if (index + 1 >= argv.length) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return argv[index + 1];
}

function runCli(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === 'generate') {
    let outputPath = null;
    let password = '';
    let force = false;
    let allowInRepo = false;
    let json = false;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--output') outputPath = parseFlagValue(rest, i++, arg);
      else if (arg === '--password') password = parseFlagValue(rest, i++, arg);
      else if (arg === '--force') force = true;
      else if (arg === '--allow-in-repo') allowInRepo = true;
      else if (arg === '--json') json = true;
      else throw new Error(`Unknown argument for generate: ${arg}`);
    }
    const result = generateMinisignKeypair({ outputPath, password, force, allowInRepo });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`[desktop:signing] Generated Tauri minisign keypair (key ID ${result.keyIdHex}).`);
    console.log(`[desktop:signing] Private key (keep offline, NEVER commit): ${result.privateKeyPath}`);
    console.log(`[desktop:signing] Public key file: ${result.publicKeyPath}`);
    console.log(`[desktop:signing] Public key (safe for GRAPHER_UPDATER_PUBKEY variable or tauri.conf.json):`);
    console.log(result.pubkey);
    return;
  }

  if (command === 'derive-pubkey') {
    let privateKeyPath = null;
    let tauriConfPath = join(root, 'src-tauri', 'tauri.conf.json');
    let checkConfigured = false;
    let json = false;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--private-key') privateKeyPath = parseFlagValue(rest, i++, arg);
      else if (arg === '--tauri-conf') tauriConfPath = parseFlagValue(rest, i++, arg);
      else if (arg === '--check-configured') checkConfigured = true;
      else if (arg === '--json') json = true;
      else throw new Error(`Unknown argument for derive-pubkey: ${arg}`);
    }
    const privateKeyInput = resolveUpdaterPrivateKeyInput({ privateKeyPath, env: process.env });
    if (!privateKeyInput) {
      throw new Error(
        'No private key provided. Pass --private-key <path> or set TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PATH.',
      );
    }
    const password = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '';
    const derived = derivePublicKeyFromMinisignSecretKey(privateKeyInput.content, password);
    const configured = resolveUpdaterPubkeySource({ tauriConfPath, env: process.env });
    let matchesConfigured = null;
    if (checkConfigured || configured.pubkey) {
      if (!configured.pubkey) {
        if (checkConfigured) {
          throw new Error(
            'No updater public key is configured in GRAPHER_UPDATER_PUBKEY, TAURI_UPDATER_PUBKEY, or src-tauri/tauri.conf.json.',
          );
        }
      } else {
        assertPrivateKeyMatchesPubkey({
          secretKeyText: privateKeyInput.content,
          password,
          configuredPubkey: configured.pubkey,
          configuredSource: configured.source,
        });
        matchesConfigured = true;
      }
    }
    const payload = {
      pubkey: derived.pubkey,
      keyIdHex: derived.keyIdHex,
      displayKeyIdHex: derived.displayKeyIdHex,
      configuredSource: configured.source,
      matchesConfigured,
    };
    if (json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(`[desktop:signing] Derived minisign public key ID: ${payload.keyIdHex}`);
    if (matchesConfigured) {
      console.log(`[desktop:signing] Matches configured public key (${configured.source}).`);
    } else if (configured.source === 'none') {
      console.log('[desktop:signing] Note: no public key is currently configured in the app/env.');
    }
    console.log(payload.pubkey);
    return;
  }

  if (command === 'check') {
    let target = null;
    let tauriConfPath = join(root, 'src-tauri', 'tauri.conf.json');
    let explicitPubkey = null;
    let privateKeyPath = null;
    let requireUpdaterSigning = false;
    let strictNative = false;
    let json = false;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--target') target = parseFlagValue(rest, i++, arg);
      else if (arg === '--tauri-conf') tauriConfPath = parseFlagValue(rest, i++, arg);
      else if (arg === '--pubkey') explicitPubkey = readPubkeyInput(parseFlagValue(rest, i++, arg));
      else if (arg === '--private-key') privateKeyPath = parseFlagValue(rest, i++, arg);
      else if (arg === '--require-updater-signing') requireUpdaterSigning = true;
      else if (arg === '--strict-native') strictNative = true;
      else if (arg === '--json') json = true;
      else throw new Error(`Unknown argument for check: ${arg}`);
    }
    const report = runSigningPreflight({
      env: process.env,
      tauriConfPath,
      explicitPubkey,
      privateKeyPath,
      target,
      requireUpdaterSigning,
      strictNative,
    });
    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(formatPreflightReport(report));
    for (const warning of report.warnings) {
      if (process.env.GITHUB_ACTIONS === 'true') {
        console.log(`::warning::${warning}`);
      } else {
        console.warn(`[desktop:signing] Warning: ${warning}`);
      }
    }
    return;
  }

  if (command === 'verify-signature') {
    let artifactPath = null;
    let sigPath = null;
    let pubkey = null;
    let tauriConfPath = join(root, 'src-tauri', 'tauri.conf.json');
    let expectedVersion = null;
    let json = false;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--artifact') artifactPath = parseFlagValue(rest, i++, arg);
      else if (arg === '--sig') sigPath = parseFlagValue(rest, i++, arg);
      else if (arg === '--pubkey') pubkey = parseFlagValue(rest, i++, arg);
      else if (arg === '--tauri-conf') tauriConfPath = parseFlagValue(rest, i++, arg);
      else if (arg === '--version' || arg === '--tag') expectedVersion = parseFlagValue(rest, i++, arg);
      else if (arg === '--json') json = true;
      else throw new Error(`Unknown argument for verify-signature: ${arg}`);
    }
    if (!artifactPath) throw new Error('--artifact <path> is required.');
    const result = verifyArtifactSignatureFile({
      artifactPath,
      sigPath: sigPath ?? `${artifactPath}.sig`,
      pubkey,
      tauriConfPath,
      env: process.env,
      expectedVersion,
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `[desktop:signing] Verified ${basename(sigPath ?? `${artifactPath}.sig`)} against ${basename(artifactPath)} (key ID ${result.keyIdHex}, signed version: ${result.signedVersion ?? 'none'}).`,
    );
    return;
  }

  if (command === 'verify-manifest') {
    let manifestPath = null;
    let assetsDir = null;
    let pubkey = null;
    let tauriConfPath = join(root, 'src-tauri', 'tauri.conf.json');
    let expectedVersion = null;
    let requireAll = false;
    let json = false;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--manifest') manifestPath = parseFlagValue(rest, i++, arg);
      else if (arg === '--assets-dir') assetsDir = parseFlagValue(rest, i++, arg);
      else if (arg === '--pubkey') pubkey = parseFlagValue(rest, i++, arg);
      else if (arg === '--tauri-conf') tauriConfPath = parseFlagValue(rest, i++, arg);
      else if (arg === '--version' || arg === '--tag') expectedVersion = parseFlagValue(rest, i++, arg);
      else if (arg === '--require-all') requireAll = true;
      else if (arg === '--json') json = true;
      else throw new Error(`Unknown argument for verify-manifest: ${arg}`);
    }
    if (!manifestPath) throw new Error('--manifest <latest.json> is required.');
    const result = verifyUpdaterManifestFile({
      manifestPath,
      assetsDir,
      pubkey,
      tauriConfPath,
      env: process.env,
      expectedVersion,
      requireAll,
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `[desktop:signing] Verified manifest ${basename(result.manifestPath)} for v${result.version} (${result.platformCount} platform key(s), pubkey: ${result.pubkeyKeyIdHex ?? 'not checked'}, payloads verified: ${result.payloadsVerified}).`,
    );
    return;
  }

  throw new Error(`Unknown command: ${command}. Run with --help for usage.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`[desktop:signing] ${error.message}`);
    process.exitCode = 1;
  }
}
