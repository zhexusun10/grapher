import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { root } from './ensure-deps.mjs';
import {
  buildTauriConfigOverride,
  resolveWindowsSigningConfig,
  sanitizedBuildEnv,
  validateUpdaterSigningConfig,
} from './desktop-build.mjs';
import { generateUpdaterManifest } from './desktop-updater-manifest.mjs';
import {
  assertPrivateKeyMatchesPubkey,
  DEFAULT_WINDOWS_TIMESTAMP_URL,
  derivePublicKeyFromMinisignSecretKey,
  generateMinisignKeypair,
  inspectMacosSigningEnv,
  inspectWindowsSigningEnv,
  runSigningPreflight,
  validateUpdaterPublicKeyStrict,
  verifyArtifactSignatureFile,
  verifyUpdaterManifestFile,
} from './desktop-signing.mjs';

const signingScript = join(root, 'scripts', 'desktop-signing.mjs');
const tauriJs = join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'grapher-signing-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runSigningCli(args, env = process.env) {
  return spawnSync(process.execPath, [signingScript, ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
}

function signRealArtifact(filePath, version, privateKey, password = '') {
  const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY: privateKey };
  if (password) {
    env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = password;
  } else {
    delete env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  }
  execFileSync(process.execPath, [tauriJs, 'signer', 'sign', '--app-version', version, filePath], {
    env,
    stdio: 'pipe',
  });
  return `${filePath}.sig`;
}

test('generates minisign keypairs safely outside the repo without ever printing private key material', t => {
  const dir = tempDir(t);

  // Guardrail: refuse writing keys inside the repository working tree by default.
  assert.throws(
    () => generateMinisignKeypair({ outputPath: join(root, '.tmp-unsafe-key.key') }),
    /Refusing to write private signing key inside the repository/,
  );

  // Password-less (--ci) keypair via CLI
  const ciKeyPath = join(dir, 'ci-updater.key');
  const cliGen = runSigningCli(['generate', '--output', ciKeyPath]);
  assert.equal(cliGen.status, 0, cliGen.stderr);
  const ciSecret = readFileSync(ciKeyPath, 'utf8').trim();
  const ciPub = readFileSync(`${ciKeyPath}.pub`, 'utf8').trim();

  assert.ok(!cliGen.stdout.includes(ciSecret), 'stdout must never contain private key material');
  assert.ok(!cliGen.stderr.includes(ciSecret), 'stderr must never contain private key material');
  assert.ok(cliGen.stdout.includes(ciPub), 'stdout should print safe public key');
  if (process.platform !== 'win32') {
    assert.equal(statSync(ciKeyPath).mode & 0o777, 0o600, 'private key must be chmod 0600');
  }

  // Passphrase-protected keypair + byte-for-byte public key derivation
  const pwKeyPath = join(dir, 'pw-updater.key');
  const pwResult = generateMinisignKeypair({ outputPath: pwKeyPath, password: 'test-passphrase-42' });
  const pwSecret = readFileSync(pwKeyPath, 'utf8').trim();
  const pwPub = readFileSync(`${pwKeyPath}.pub`, 'utf8').trim();
  assert.equal(pwResult.pubkey, pwPub);

  const derivedCi = derivePublicKeyFromMinisignSecretKey(ciSecret, '');
  assert.equal(derivedCi.pubkey, ciPub);

  const derivedPw = derivePublicKeyFromMinisignSecretKey(pwSecret, 'test-passphrase-42');
  assert.equal(derivedPw.pubkey, pwPub);

  // Wrong passphrase fails explicitly without printing secret bytes.
  assert.throws(
    () => derivePublicKeyFromMinisignSecretKey(pwSecret, 'wrong-password'),
    error => {
      assert.match(error.message, /wrong TAURI_SIGNING_PRIVATE_KEY_PASSWORD|Failed to decrypt/i);
      assert.ok(!error.message.includes(pwSecret));
      return true;
    },
  );

  // Rejects public key accidentally supplied in private key slot.
  assert.throws(
    () => derivePublicKeyFromMinisignSecretKey(ciPub, ''),
    /PUBLIC key instead of a private signing key/i,
  );

  // Rejects raw un-base64-encoded 2-line public key with clear guidance.
  const rawTwoLinePub = Buffer.from(ciPub, 'base64').toString('utf8');
  assert.throws(
    () => validateUpdaterPublicKeyStrict(rawTwoLinePub),
    /raw 2-line minisign text rather than the base64-encoded public key/i,
  );

  // Rejects private key accidentally supplied in public key slot.
  assert.throws(
    () => validateUpdaterPublicKeyStrict(ciSecret),
    /secret key material/i,
  );
});

test('preflight check catches missing, malformed, and mismatched updater keys before build while preserving unsigned installer-only mode', t => {
  const dir = tempDir(t);
  const keyA = generateMinisignKeypair({ outputPath: join(dir, 'a.key') });
  const keyB = generateMinisignKeypair({ outputPath: join(dir, 'b.key') });
  const secretA = readFileSync(keyA.privateKeyPath, 'utf8').trim();
  const secretB = readFileSync(keyB.privateKeyPath, 'utf8').trim();

  const emptyConf = join(dir, 'empty.tauri.conf.json');
  const confWithA = join(dir, 'a.tauri.conf.json');
  writeFileSync(emptyConf, JSON.stringify({ plugins: { updater: { pubkey: '' } } }));
  writeFileSync(confWithA, JSON.stringify({ plugins: { updater: { pubkey: keyA.pubkey } } }));

  // 1. Unsigned installer-only mode succeeds cleanly with empty config OR committed pubkey.
  const unsignedEmpty = runSigningPreflight({ env: {}, tauriConfPath: emptyConf });
  assert.equal(unsignedEmpty.updater.mode, 'unsigned-installer-only');
  assert.equal(unsignedEmpty.updater.signingEnabled, false);
  assert.equal(unsignedEmpty.updater.pubkey, null);

  const unsignedWithPub = runSigningPreflight({ env: {}, tauriConfPath: confWithA });
  assert.equal(unsignedWithPub.updater.mode, 'unsigned-installer-only');
  assert.equal(unsignedWithPub.updater.pubkey, keyA.pubkey);
  assert.equal(unsignedWithPub.updater.pubkeySource, 'tauri.conf.json');

  // --require-updater-signing fails when private key is absent.
  assert.throws(
    () => runSigningPreflight({ env: {}, tauriConfPath: confWithA, requireUpdaterSigning: true }),
    /TAURI_SIGNING_PRIVATE_KEY.*is not configured/,
  );

  // 2. Private key set without public key fails with actionable GitHub Variable hint.
  assert.throws(
    () =>
      runSigningPreflight({
        env: { TAURI_SIGNING_PRIVATE_KEY: secretA },
        tauriConfPath: emptyConf,
      }),
    /GRAPHER_UPDATER_PUBKEY GitHub Actions Variable \(not a Secret\)/,
  );

  // 3. Private key / public key mismatch fails immediately in preflight AND desktop-build validation.
  assert.throws(
    () =>
      assertPrivateKeyMatchesPubkey({
        secretKeyText: secretA,
        configuredPubkey: keyB.pubkey,
        configuredSource: 'GRAPHER_UPDATER_PUBKEY',
      }),
    /keypair mismatch.*derives key ID.*has key ID/i,
  );
  assert.throws(
    () =>
      validateUpdaterSigningConfig({
        env: {
          TAURI_SIGNING_PRIVATE_KEY: secretA,
          GRAPHER_UPDATER_PUBKEY: keyB.pubkey,
        },
        tauriConfPath: emptyConf,
      }),
    /keypair mismatch/i,
  );

  // 4. Matching pair succeeds in both preflight and desktop-build validation.
  const matched = runSigningPreflight({
    env: {
      TAURI_SIGNING_PRIVATE_KEY: secretB,
      GRAPHER_UPDATER_PUBKEY: keyB.pubkey,
    },
    tauriConfPath: confWithA,
  });
  assert.equal(matched.updater.mode, 'signed');
  assert.equal(matched.updater.keypairVerified, true);
  assert.equal(matched.updater.pubkeySource, 'GRAPHER_UPDATER_PUBKEY');
  assert.equal(matched.updater.keyIdHex, keyB.keyIdHex);

  // 5. CLI `derive-pubkey --check-configured` and `check --json` never print private key bytes.
  const cliEnv = {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY: secretA,
    GRAPHER_UPDATER_PUBKEY: keyA.pubkey,
  };
  delete cliEnv.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;

  const deriveRun = runSigningCli(
    ['derive-pubkey', '--tauri-conf', emptyConf, '--check-configured', '--json'],
    cliEnv,
  );
  assert.equal(deriveRun.status, 0, deriveRun.stderr);
  assert.ok(!deriveRun.stdout.includes(secretA));
  const derivedJson = JSON.parse(deriveRun.stdout);
  assert.equal(derivedJson.pubkey, keyA.pubkey);
  assert.equal(derivedJson.matchesConfigured, true);

  const checkRun = runSigningCli(['check', '--tauri-conf', emptyConf, '--json'], cliEnv);
  assert.equal(checkRun.status, 0, checkRun.stderr);
  assert.ok(!checkRun.stdout.includes(secretA));
  const checkedJson = JSON.parse(checkRun.stdout);
  assert.equal(checkedJson.updater.keypairVerified, true);
});

test('separates and reports optional macOS Developer ID/notarization and Windows Authenticode states cleanly', () => {
  // macOS states
  assert.equal(inspectMacosSigningEnv({}).codeSigningStatus, 'ad-hoc');
  assert.equal(inspectMacosSigningEnv({}).notarizationStatus, 'skipped');

  const partialMac = inspectMacosSigningEnv({ APPLE_CERTIFICATE: 'AAAA' });
  assert.equal(partialMac.codeSigningStatus, 'partial');
  assert.deepEqual(partialMac.missingCodeSigning, [
    'APPLE_CERTIFICATE_PASSWORD',
    'APPLE_SIGNING_IDENTITY',
  ]);
  assert.equal(partialMac.warnings.length, 1);

  const fullMac = inspectMacosSigningEnv({
    APPLE_CERTIFICATE: 'AAAA',
    APPLE_CERTIFICATE_PASSWORD: 'pw',
    APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example (TEAMID1234)',
    APPLE_API_KEY: 'KEYID',
    APPLE_API_ISSUER: 'ISSUER',
    APPLE_API_KEY_P8: '-----BEGIN PRIVATE KEY-----\nabc',
  });
  assert.equal(fullMac.codeSigningStatus, 'configured-ci-p12');
  assert.equal(fullMac.notarizationStatus, 'configured-api-key');
  assert.deepEqual(fullMac.warnings, []);

  const notaryWithoutDevId = inspectMacosSigningEnv({
    APPLE_ID: 'dev@example.com',
    APPLE_PASSWORD: 'pw',
    APPLE_TEAM_ID: 'TEAMID1234',
  });
  assert.equal(notaryWithoutDevId.notarizationStatus, 'requires-developer-id');
  assert.equal(notaryWithoutDevId.warnings.length, 1);

  // Windows states
  assert.equal(inspectWindowsSigningEnv({}).status, 'unsigned');
  assert.equal(inspectWindowsSigningEnv({}).timestampUrl, DEFAULT_WINDOWS_TIMESTAMP_URL);

  const partialWin = inspectWindowsSigningEnv({ WINDOWS_CERTIFICATE: 'AAAA' });
  assert.equal(partialWin.status, 'partial');
  assert.deepEqual(partialWin.missing, ['WINDOWS_CERTIFICATE_PASSWORD']);
  assert.equal(partialWin.warnings.length, 1);

  const pfxWin = inspectWindowsSigningEnv({
    WINDOWS_CERTIFICATE: Buffer.from('fake-pfx-bytes').toString('base64'),
    WINDOWS_CERTIFICATE_PASSWORD: 'pw',
  });
  assert.equal(pfxWin.status, 'configured-pfx');
  assert.deepEqual(pfxWin.errors, []);

  const badBase64Pfx = inspectWindowsSigningEnv({
    WINDOWS_CERTIFICATE: 'not!valid!base64',
    WINDOWS_CERTIFICATE_PASSWORD: 'pw',
  });
  assert.equal(badBase64Pfx.status, 'invalid');
  assert.match(badBase64Pfx.errors[0], /valid base64/);

  const thumbprint = '0123456789abcdef0123456789abcdef01234567';
  const winThumb = resolveWindowsSigningConfig({
    WINDOWS_CERTIFICATE_THUMBPRINT: thumbprint,
    WINDOWS_TIMESTAMP_URL: 'https://timestamp.sectigo.com',
  });
  assert.deepEqual(winThumb, {
    mode: 'thumbprint',
    certificateThumbprint: thumbprint.toUpperCase(),
    thumbprintPreview: '01234567...4567',
    digestAlgorithm: 'sha256',
    timestampUrl: 'https://timestamp.sectigo.com',
    tsp: true,
  });

  assert.throws(
    () => resolveWindowsSigningConfig({ WINDOWS_CERTIFICATE_THUMBPRINT: 'bad-thumb' }),
    /40-character hexadecimal SHA-1/,
  );
  assert.throws(
    () => resolveWindowsSigningConfig({ WINDOWS_SIGN_COMMAND: 'signtool sign /fd sha256' }),
    /must include the "%1" placeholder/,
  );

  const winCmd = resolveWindowsSigningConfig({
    WINDOWS_SIGN_COMMAND: 'trusted-signing-cli sign "%1"',
  });
  assert.equal(winCmd.mode, 'sign-command');

  // Tauri `--config` override embeds both resolved updater pubkey and optional Windows signing config.
  const cfgThumb = buildTauriConfigOverride({ pubkey: 'PUBKEY_B64', windowsSigning: winThumb });
  assert.equal(cfgThumb.bundle.createUpdaterArtifacts, false);
  assert.equal(cfgThumb.plugins.updater.pubkey, 'PUBKEY_B64');
  assert.equal(cfgThumb.bundle.windows.certificateThumbprint, thumbprint.toUpperCase());
  assert.equal(cfgThumb.bundle.windows.digestAlgorithm, 'sha256');
  assert.equal(cfgThumb.bundle.windows.tsp, true);

  const cfgCmd = buildTauriConfigOverride({ pubkey: 'PUBKEY_B64', windowsSigning: winCmd });
  assert.equal(cfgCmd.bundle.windows.signCommand, 'trusted-signing-cli sign "%1"');

  // Secret sanitization strips Windows certificate secrets alongside updater & Apple secrets.
  const clean = sanitizedBuildEnv({
    PATH: '/usr/bin',
    GRAPHER_UPDATER_PUBKEY: 'PUBKEY_B64',
    TAURI_SIGNING_PRIVATE_KEY: 'sk',
    APPLE_CERTIFICATE: 'p12',
    WINDOWS_CERTIFICATE: 'pfx',
    WINDOWS_CERTIFICATE_PASSWORD: 'pw',
    WINDOWS_SIGN_COMMAND: 'cmd %1',
  });
  assert.equal(clean.GRAPHER_UPDATER_PUBKEY, 'PUBKEY_B64');
  assert.equal(clean.TAURI_SIGNING_PRIVATE_KEY, undefined);
  assert.equal(clean.APPLE_CERTIFICATE, undefined);
  assert.equal(clean.WINDOWS_CERTIFICATE, undefined);
  assert.equal(clean.WINDOWS_CERTIFICATE_PASSWORD, undefined);
  assert.equal(clean.WINDOWS_SIGN_COMMAND, undefined);
});

test('verifies standalone .sig files and latest.json manifests end-to-end and fails closed on tampering or wrong keys', t => {
  const dir = tempDir(t);
  const assetsDir = join(dir, 'release-assets');
  mkdirSync(assetsDir, { recursive: true });

  const keyA = generateMinisignKeypair({ outputPath: join(dir, 'rel-a.key') });
  const keyB = generateMinisignKeypair({ outputPath: join(dir, 'rel-b.key') });
  const secretA = readFileSync(keyA.privateKeyPath, 'utf8').trim();

  const armTar = join(assetsDir, 'Grapher_1.9.9_aarch64.app.tar.gz');
  const x64Tar = join(assetsDir, 'Grapher_1.9.9_x64.app.tar.gz');
  const winExe = join(assetsDir, 'Grapher_1.9.9_x64-setup.exe');
  writeFileSync(armTar, 'arm64-signed-tarball');
  writeFileSync(x64Tar, 'x64-signed-tarball');
  writeFileSync(winExe, 'windows-signed-nsis-exe');

  const armSig = signRealArtifact(armTar, '1.9.9', secretA);
  signRealArtifact(x64Tar, '1.9.9', secretA);
  signRealArtifact(winExe, '1.9.9', secretA);

  const manifestPath = join(assetsDir, 'latest.json');
  generateUpdaterManifest({
    assetsDir,
    outputPath: manifestPath,
    tag: 'v1.9.9',
    repo: 'zhexusun10/grapher',
    pubkey: keyA.pubkey,
    requirePubkey: true,
    requireAllWhenSigned: true,
    log: () => {},
  });

  // Direct API + CLI verification succeed with matching public key.
  const sigVerified = verifyArtifactSignatureFile({
    artifactPath: armTar,
    sigPath: armSig,
    pubkey: keyA.pubkey,
    expectedVersion: '1.9.9',
  });
  assert.equal(sigVerified.keyIdHex, keyA.keyIdHex);
  assert.equal(sigVerified.signedVersion, '1.9.9');

  const manifestVerified = verifyUpdaterManifestFile({
    manifestPath,
    assetsDir,
    pubkey: keyA.pubkey,
    expectedVersion: 'v1.9.9',
    requireAll: true,
  });
  assert.equal(manifestVerified.platformCount, 6);
  assert.equal(manifestVerified.payloadsVerified, true);

  const cliVerifySig = runSigningCli([
    'verify-signature',
    '--artifact',
    armTar,
    '--pubkey',
    keyA.publicKeyPath,
    '--version',
    '1.9.9',
  ]);
  assert.equal(cliVerifySig.status, 0, cliVerifySig.stderr);

  const cliVerifyManifest = runSigningCli([
    'verify-manifest',
    '--manifest',
    manifestPath,
    '--assets-dir',
    assetsDir,
    '--pubkey',
    keyA.publicKeyPath,
    '--tag',
    'v1.9.9',
    '--require-all',
  ]);
  assert.equal(cliVerifyManifest.status, 0, cliVerifyManifest.stderr);

  // Wrong public key fails closed on both signature and manifest verification.
  assert.throws(
    () =>
      verifyArtifactSignatureFile({
        artifactPath: armTar,
        sigPath: armSig,
        pubkey: keyB.pubkey,
        expectedVersion: '1.9.9',
      }),
    /does not match configured public key ID/,
  );
  assert.throws(
    () =>
      verifyUpdaterManifestFile({
        manifestPath,
        assetsDir,
        pubkey: keyB.pubkey,
        expectedVersion: '1.9.9',
      }),
    /does not match configured public key ID/,
  );

  // Tampering with payload after signing fails Ed25519 verification.
  writeFileSync(winExe, 'tampered-windows-exe');
  assert.throws(
    () =>
      verifyUpdaterManifestFile({
        manifestPath,
        assetsDir,
        pubkey: keyA.pubkey,
        expectedVersion: '1.9.9',
      }),
    /failed Ed25519 payload signature verification/,
  );
});

test('release workflow wires preflight signing checks, Windows Authenticode signing + cleanup, and documented secret/variable names', () => {
  const workflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8');

  // Preflight check runs before Pi setup / compilation so key mismatches fail fast.
  const preflightIdx = workflow.indexOf('node scripts/desktop-signing.mjs check');
  const piSetupIdx = workflow.indexOf('run: npm run pi:setup', workflow.indexOf('build-desktop:'));
  assert.ok(preflightIdx > 0, 'release workflow must run desktop-signing.mjs check');
  assert.ok(piSetupIdx > preflightIdx, 'signing preflight must run before pi:setup in build-desktop');

  // Post-generation manifest verification gate in create-release.
  assert.match(workflow, /node scripts\/desktop-signing\.mjs verify-manifest/);

  // Optional Windows Authenticode setup & cleanup steps.
  assert.match(workflow, /Configure optional Windows Authenticode signing credentials/);
  assert.match(workflow, /if:\s*always\(\)\s*&&\s*matrix\.platform\s*==\s*'windows'/);
  assert.match(workflow, /Import-PfxCertificate/);

  // Exact documented secret and variable names.
  for (const name of [
    'vars.GRAPHER_UPDATER_PUBKEY',
    'secrets.TAURI_SIGNING_PRIVATE_KEY',
    'secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
    'secrets.APPLE_CERTIFICATE',
    'secrets.APPLE_CERTIFICATE_PASSWORD',
    'secrets.APPLE_SIGNING_IDENTITY',
    'secrets.APPLE_API_KEY',
    'secrets.APPLE_API_ISSUER',
    'secrets.APPLE_API_KEY_P8',
    'secrets.APPLE_ID',
    'secrets.APPLE_PASSWORD',
    'secrets.APPLE_TEAM_ID',
    'secrets.WINDOWS_CERTIFICATE',
    'secrets.WINDOWS_CERTIFICATE_PASSWORD',
    'secrets.WINDOWS_CERTIFICATE_THUMBPRINT',
    'secrets.WINDOWS_SIGN_COMMAND',
    'vars.WINDOWS_TIMESTAMP_URL',
  ]) {
    assert.ok(workflow.includes(name), `release.yml missing documented credential reference: ${name}`);
  }
});
