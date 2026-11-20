import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { root } from './ensure-deps.mjs';
import {
  assertTagMatchesVersion,
  desktopArtifactNames,
  hasUpdaterSigningKey,
  resolveMacosNotarizationConfig,
  sanitizedBuildEnv,
  validateUpdaterSigningConfig,
  verifySignedUpdaterArtifact,
} from './desktop-build.mjs';
import { DESKTOP_TARGETS } from './desktop-stage.mjs';
import {
  buildReleaseDownloadUrl,
  consolidateReleaseAssets,
  extractChangelogNotes,
  generateUpdaterManifest,
  normalizeVersion,
  resolveConfiguredUpdaterPubkey,
  validateMinisignPublicKey,
  validateMinisignSignature,
  validateUpdaterManifestObject,
  verifyMinisignSignatureAgainstPayload,
} from './desktop-updater-manifest.mjs';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'grapher-updater-manifest-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeFakeSignature(version = '1.9.9', file = 'Grapher_1.9.9_aarch64.app.tar.gz') {
  const payload = [
    'untrusted comment: signature from tauri secret key',
    'RUTI21Seiezr6GYYZQpvSHOPcJQoti+RDoD4K+pZ8pC8ltD2sDR8v8uekTzErszVCIYxh0gIuvIQvRf1sqbj1EfnIdLYwla/xg4=',
    `trusted comment: timestamp:1795063065\tfile:${file}\tversion:${version}`,
    '92x19wfvtNji9FvImZQx7w3HQOPyrKl+ig94I4afGH+9hZYMnMg9p4CJKmOdUynnjHqP+aOdIOkEalewQECICw==',
  ].join('\n');
  return Buffer.from(`${payload}\n`, 'utf8').toString('base64');
}

function generateTestKeypair(keyDir, name = 'test-updater') {
  const tauriJs = join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  const keyFile = join(keyDir, `${name}.key`);
  if (!existsSync(keyFile)) {
    execFileSync(process.execPath, [tauriJs, 'signer', 'generate', '--ci', '-w', keyFile], {
      stdio: 'pipe',
    });
  }
  return {
    keyFile,
    privateKey: readFileSync(keyFile, 'utf8'),
    publicKey: readFileSync(`${keyFile}.pub`, 'utf8').trim(),
  };
}

function signWithRealTauriCli(filePath, version, keyDir, keyName = 'test-updater') {
  const tauriJs = join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  const { privateKey, publicKey } = generateTestKeypair(keyDir, keyName);
  const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY: privateKey };
  delete env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  const args = version
    ? [tauriJs, 'signer', 'sign', '--app-version', version, filePath]
    : [tauriJs, 'signer', 'sign', filePath];
  execFileSync(process.execPath, args, { env, stdio: 'pipe' });
  return { sigPath: `${filePath}.sig`, publicKey };
}

test('generates Tauri v2 plugin-compatible latest.json for macOS arm64, macOS x64, and Windows x64 using real Tauri CLI signatures', t => {
  const dir = tempDir(t);
  const assetsDir = join(dir, 'release-assets');
  const keyDir = join(dir, 'keys');
  mkdirSync(assetsDir, { recursive: true });
  mkdirSync(keyDir, { recursive: true });

  // Relocatable archives + installers + checksums (must be ignored by updater feed)
  writeFileSync(join(assetsDir, 'grapher-linux-x64.tar.gz'), 'linux-archive');
  writeFileSync(join(assetsDir, 'grapher-linux-x64.tar.gz.sha256'), 'deadbeef  grapher-linux-x64.tar.gz\n');
  writeFileSync(join(assetsDir, 'Grapher_1.9.9_aarch64.dmg'), 'mac-arm64-dmg');
  writeFileSync(join(assetsDir, 'Grapher_1.9.9_x64.dmg'), 'mac-x64-dmg');

  // Signed updater payloads for all 3 desktop targets
  const armTar = join(assetsDir, 'Grapher_1.9.9_aarch64.app.tar.gz');
  const x64Tar = join(assetsDir, 'Grapher_1.9.9_x64.app.tar.gz');
  const winExe = join(assetsDir, 'Grapher_1.9.9_x64-setup.exe');
  writeFileSync(armTar, 'arm64-app-tarball');
  writeFileSync(x64Tar, 'x64-app-tarball');
  writeFileSync(winExe, 'windows-nsis-installer');

  const { sigPath: armSigPath, publicKey } = signWithRealTauriCli(armTar, '1.9.9', keyDir);
  const { sigPath: x64SigPath } = signWithRealTauriCli(x64Tar, '1.9.9', keyDir);
  const { sigPath: winSigPath } = signWithRealTauriCli(winExe, '1.9.9', keyDir);

  const changelogPath = join(dir, 'CHANGELOG.md');
  writeFileSync(
    changelogPath,
    [
      '# Changelog',
      '',
      '## [Unreleased]',
      '- Future item',
      '',
      '## [1.9.9] - 2026-11-19',
      '### Added',
      '- Native desktop installers and signed auto-updates.',
      '',
      '## [1.9.8] - 2026-10-01',
      '- Previous release.',
    ].join('\n'),
  );

  const outputPath = join(assetsDir, 'latest.json');
  const logs = [];
  const result = generateUpdaterManifest({
    assetsDir,
    outputPath,
    tag: 'v1.9.9',
    repo: 'zhexusun10/grapher',
    changelogPath,
    pubDate: '2026-11-19T12:30:00Z',
    pubkey: publicKey,
    requirePubkey: true,
    requireAllWhenSigned: true,
    requireAll: true,
    log: msg => logs.push(msg),
  });

  assert.equal(result.written, true);
  assert.equal(result.skipped, false);
  assert.equal(result.verifiedPubkey, true);
  assert.deepEqual(result.targets, ['macos-arm64', 'macos-x64', 'windows-x64']);
  assert.equal(existsSync(outputPath), true);

  const parsed = JSON.parse(readFileSync(outputPath, 'utf8'));
  assert.equal(parsed.version, '1.9.9');
  assert.equal(parsed.pub_date, '2026-11-19T12:30:00Z');
  assert.match(parsed.notes, /Native desktop installers and signed auto-updates/);
  assert.doesNotMatch(parsed.notes, /Future item/);
  assert.doesNotMatch(parsed.notes, /Previous release/);

  assert.deepEqual(Object.keys(parsed.platforms), [
    'darwin-aarch64',
    'darwin-aarch64-app',
    'darwin-x86_64',
    'darwin-x86_64-app',
    'windows-x86_64',
    'windows-x86_64-nsis',
  ]);

  const armSig = readFileSync(armSigPath, 'utf8').trim();
  const x64Sig = readFileSync(x64SigPath, 'utf8').trim();
  const winSig = readFileSync(winSigPath, 'utf8').trim();

  assert.deepEqual(parsed.platforms['darwin-aarch64'], {
    signature: armSig,
    url: 'https://github.com/zhexusun10/grapher/releases/download/v1.9.9/Grapher_1.9.9_aarch64.app.tar.gz',
  });
  assert.deepEqual(parsed.platforms['darwin-aarch64-app'], parsed.platforms['darwin-aarch64']);

  assert.deepEqual(parsed.platforms['darwin-x86_64'], {
    signature: x64Sig,
    url: 'https://github.com/zhexusun10/grapher/releases/download/v1.9.9/Grapher_1.9.9_x64.app.tar.gz',
  });
  assert.deepEqual(parsed.platforms['darwin-x86_64-app'], parsed.platforms['darwin-x86_64']);

  assert.deepEqual(parsed.platforms['windows-x86_64'], {
    signature: winSig,
    url: 'https://github.com/zhexusun10/grapher/releases/download/v1.9.9/Grapher_1.9.9_x64-setup.exe',
  });
  assert.deepEqual(parsed.platforms['windows-x86_64-nsis'], parsed.platforms['windows-x86_64']);
});

test('unsigned releases cleanly skip latest.json generation and remove any stale manifest', t => {
  const dir = tempDir(t);
  const assetsDir = join(dir, 'release-assets');
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(assetsDir, 'Grapher_1.9.9_aarch64.dmg'), 'dmg-bytes');
  writeFileSync(join(assetsDir, 'Grapher_1.9.9_x64.dmg'), 'dmg-bytes');
  writeFileSync(join(assetsDir, 'Grapher_1.9.9_x64-setup.exe'), 'exe-bytes');

  const outputPath = join(assetsDir, 'latest.json');
  writeFileSync(outputPath, '{"stale":true}\n');

  const logs = [];
  const skipped = generateUpdaterManifest({
    assetsDir,
    outputPath,
    tag: 'v1.9.9',
    log: msg => logs.push(msg),
  });

  assert.equal(skipped.written, false);
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, 'no-signed-artifacts');
  assert.equal(existsSync(outputPath), false, 'stale latest.json must be removed when skipping');
  assert.ok(logs.some(line => /skipping latest\.json/i.test(line)));

  // Explicit --allow-empty produces a valid empty-platforms manifest.
  const emptyResult = generateUpdaterManifest({
    assetsDir,
    outputPath,
    tag: 'v1.9.9',
    pubDate: '2026-11-19T12:30:00Z',
    allowEmpty: true,
    log: () => {},
  });
  assert.equal(emptyResult.written, true);
  assert.deepEqual(JSON.parse(readFileSync(outputPath, 'utf8')).platforms, {});
});

test('partial signed targets warn by default and fail under requireAll', t => {
  const dir = tempDir(t);
  const assetsDir = join(dir, 'release-assets');
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(assetsDir, 'Grapher_2.0.0-rc.1_x64-setup.exe'), 'exe-bytes');
  writeFileSync(
    join(assetsDir, 'Grapher_2.0.0-rc.1_x64-setup.exe.sig'),
    makeFakeSignature('2.0.0-rc.1', 'Grapher_2.0.0-rc.1_x64-setup.exe'),
  );

  const warnings = [];
  const outputPath = join(assetsDir, 'latest.json');
  const partial = generateUpdaterManifest({
    assetsDir,
    outputPath,
    tag: 'v2.0.0-rc.1',
    notes: 'Release candidate notes',
    pubDate: '2026-11-19T12:30:00Z',
    log: () => {},
    warn: msg => warnings.push(msg),
  });
  assert.equal(partial.written, true);
  assert.deepEqual(partial.targets, ['windows-x64']);
  assert.ok(warnings.some(line => line.includes('macos-arm64') && line.includes('macos-x64')));
  assert.deepEqual(Object.keys(partial.manifest.platforms), [
    'windows-x86_64',
    'windows-x86_64-nsis',
  ]);

  assert.throws(
    () =>
      generateUpdaterManifest({
        assetsDir,
        outputPath,
        tag: 'v2.0.0-rc.1',
        requireAll: true,
        log: () => {},
      }),
    /Missing signed Tauri updater artifacts.*macos-arm64, macos-x64/,
  );

  // Under CI's --require-all-when-signed, partial signed artifacts fail closed instead of publishing a partial feed.
  assert.throws(
    () =>
      generateUpdaterManifest({
        assetsDir,
        outputPath,
        tag: 'v2.0.0-rc.1',
        requireAllWhenSigned: true,
        log: () => {},
      }),
    /Refusing to generate partial latest\.json.*macos-arm64, macos-x64/,
  );
});

test('enforces cryptographic keypair verification, catches wrong target/artifact names, and blocks mismatched/missing signing config', t => {
  const dir = tempDir(t);
  const keyDir = join(dir, 'keys');
  const assetsDir = join(dir, 'assets');
  mkdirSync(keyDir, { recursive: true });
  mkdirSync(assetsDir, { recursive: true });

  const keyA = generateTestKeypair(keyDir, 'key-a');
  const keyB = generateTestKeypair(keyDir, 'key-b');
  const parsedPubA = validateMinisignPublicKey(keyA.publicKey);
  assert.match(parsedPubA.keyIdHex, /^[0-9A-F]{16}$/);

  // Reject private/secret keys or malformed data in pubkey slots.
  assert.throws(() => validateMinisignPublicKey(''), /is empty/);
  assert.throws(() => validateMinisignPublicKey(keyA.privateKey), /secret key material/i);
  assert.throws(
    () => validateMinisignPublicKey(Buffer.from('untrusted comment: not-a-key\nAAAA\n').toString('base64')),
    /valid 42-byte Ed25519 minisign public key/,
  );

  // Build config guardrails:
  const emptyConf = join(dir, 'empty-tauri.conf.json');
  const populatedConf = join(dir, 'pub-tauri.conf.json');
  writeFileSync(emptyConf, JSON.stringify({ plugins: { updater: { pubkey: '' } } }));
  writeFileSync(populatedConf, JSON.stringify({ plugins: { updater: { pubkey: keyA.publicKey } } }));

  // 1. Unsigned installer-only builds succeed both without and with a valid pubkey.
  assert.deepEqual(validateUpdaterSigningConfig({ env: {}, tauriConfPath: emptyConf }), {
    signingEnabled: false,
    pubkey: null,
    pubkeySource: 'none',
    keyIdHex: null,
    keypairVerified: false,
  });
  assert.equal(
    validateUpdaterSigningConfig({ env: {}, tauriConfPath: populatedConf }).signingEnabled,
    false,
  );
  // 2. Signed build without a configured pubkey fails closed before compiling.
  assert.throws(
    () =>
      validateUpdaterSigningConfig({
        env: { TAURI_SIGNING_PRIVATE_KEY: keyA.privateKey },
        tauriConfPath: emptyConf,
      }),
    /TAURI_SIGNING_PRIVATE_KEY is set, but no updater public key is configured/,
  );
  // 3. Signed build with matching env/config pubkey succeeds preflight and resolves precedence identically to Rust.
  assert.equal(
    resolveConfiguredUpdaterPubkey({
      tauriConfPath: populatedConf,
      env: { GRAPHER_UPDATER_PUBKEY: '   ', TAURI_UPDATER_PUBKEY: keyB.publicKey },
    }),
    keyB.publicKey,
  );
  assert.equal(
    validateUpdaterSigningConfig({
      env: { TAURI_SIGNING_PRIVATE_KEY: keyA.privateKey, GRAPHER_UPDATER_PUBKEY: keyA.publicKey },
      tauriConfPath: emptyConf,
    }).keyIdHex,
    parsedPubA.keyIdHex,
  );

  // Sign Windows NSIS .exe + macOS tarballs with keyA and verify cryptographic checks.
  const armTar = join(assetsDir, 'Grapher_1.9.9_aarch64.app.tar.gz');
  const x64Tar = join(assetsDir, 'Grapher_1.9.9_x64.app.tar.gz');
  const winExe = join(assetsDir, 'Grapher_1.9.9_x64-setup.exe');
  writeFileSync(armTar, 'arm-payload');
  writeFileSync(x64Tar, 'x64-payload');
  writeFileSync(winExe, 'win-nsis-exe-payload');
  signWithRealTauriCli(armTar, '1.9.9', keyDir, 'key-a');
  signWithRealTauriCli(x64Tar, '1.9.9', keyDir, 'key-a');
  const { sigPath: winSigPath } = signWithRealTauriCli(winExe, '1.9.9', keyDir, 'key-a');

  // Matching key verifies cleanly.
  const verifiedWin = verifySignedUpdaterArtifact(winExe, winSigPath, {
    pubkey: keyA.publicKey,
    version: '1.9.9',
  });
  assert.equal(verifiedWin.keyIdHex, parsedPubA.keyIdHex);
  assert.equal(verifiedWin.signedVersion, '1.9.9');

  // Wrong keypair (keyB pubkey vs keyA sig) fails closed in both build and manifest checks.
  assert.throws(
    () => verifySignedUpdaterArtifact(winExe, winSigPath, { pubkey: keyB.publicKey, version: '1.9.9' }),
    /does not match configured public key ID/,
  );
  assert.throws(
    () =>
      generateUpdaterManifest({
        assetsDir,
        outputPath: join(dir, 'bad-key.json'),
        tag: 'v1.9.9',
        pubkey: keyB.publicKey,
        requirePubkey: true,
        requireAllWhenSigned: true,
        log: () => {},
      }),
    /does not match configured public key ID/,
  );

  // Signed artifacts with NO configured pubkey fail closed under --require-pubkey.
  assert.throws(
    () =>
      generateUpdaterManifest({
        assetsDir,
        outputPath: join(dir, 'no-key.json'),
        tag: 'v1.9.9',
        tauriConfPath: emptyConf,
        env: {},
        requirePubkey: true,
        requireAllWhenSigned: true,
        log: () => {},
      }),
    /no matching updater public key is configured/,
  );

  // Tampered payload bytes fail Ed25519 verification even with the right key ID.
  assert.throws(
    () =>
      verifyMinisignSignatureAgainstPayload({
        payloadBytes: Buffer.from('tampered-win-nsis-exe-payload'),
        signatureText: readFileSync(winSigPath, 'utf8'),
        pubkeyText: keyA.publicKey,
        expectedVersion: '1.9.9',
      }),
    /failed Ed25519 payload signature verification/,
  );

  // Signature without `--app-version` is rejected because `requireSignedVersion` is enabled.
  const unversionedPath = join(dir, 'unversioned.exe');
  writeFileSync(unversionedPath, 'unversioned');
  const { sigPath: unversionedSig } = signWithRealTauriCli(unversionedPath, null, keyDir, 'key-a');
  assert.throws(
    () => validateMinisignSignature(readFileSync(unversionedSig, 'utf8'), '1.9.9'),
    /missing a signed version in its trusted comment/,
  );

  // Wrong Windows/macOS artifact extensions or version-mismatched filenames are rejected.
  for (const badAsset of [
    'Grapher_1.9.9_x64-setup.nsis.zip',
    'Grapher_1.9.9_x64.msi',
    'Grapher_1.9.9_aarch64.dmg',
    'Grapher_1.9.8_x64-setup.exe',
  ]) {
    const badDir = tempDir(t);
    writeFileSync(join(badDir, badAsset), 'bytes');
    writeFileSync(join(badDir, `${badAsset}.sig`), makeFakeSignature('1.9.9', badAsset));
    assert.throws(
      () => generateUpdaterManifest({ assetsDir: badDir, tag: 'v1.9.9', log: () => {} }),
      /Unrecognized Tauri updater signature file|embeds version "1\.9\.8"/,
      `expected rejection for ${badAsset}`,
    );
  }

  // Malformed or wrong-target manifests are rejected by validateUpdaterManifestObject.
  const validSig = readFileSync(winSigPath, 'utf8').trim();
  assert.throws(
    () => validateUpdaterManifestObject({ version: '1.9.9' }),
    /must include a `platforms` object/,
  );
  assert.throws(
    () =>
      validateUpdaterManifestObject({
        version: '1.9.9',
        pub_date: '2026-11-19T12:00:00Z',
        platforms: {
          'windows-x64': {
            url: 'https://github.com/zhexusun10/grapher/releases/download/v1.9.9/Grapher_1.9.9_x64-setup.exe',
            signature: validSig,
          },
        },
      }),
    /Unsupported or unrecognized platform key "windows-x64"/,
  );
  assert.throws(
    () =>
      validateUpdaterManifestObject({
        version: '1.9.9',
        pub_date: '2026-11-19T12:00:00Z',
        platforms: {
          'windows-x86_64-nsis': {
            url: 'https://github.com/zhexusun10/grapher/releases/download/v1.9.9/Grapher_1.9.9_x64.msi',
            signature: validSig,
          },
        },
      }),
    /incompatible artifact "Grapher_1\.9\.9_x64\.msi"/,
  );
  assert.throws(
    () =>
      validateUpdaterManifestObject({
        version: '1.9.9',
        pub_date: '2026-11-19T12:00:00Z',
        platforms: {
          'windows-x86_64-nsis': {
            url: 'http://github.com/zhexusun10/grapher/releases/download/v1.9.9/Grapher_1.9.9_x64-setup.exe',
            signature: validSig,
          },
        },
      }),
    /must use an https:\/\/ download URL/,
  );
  assert.throws(
    () =>
      validateUpdaterManifestObject(
        {
          version: '1.9.9',
          pub_date: '2026-11-19T12:00:00Z',
          platforms: {
            'windows-x86_64': {
              url: 'https://github.com/zhexusun10/grapher/releases/download/v1.9.9/Grapher_1.9.9_x64-setup.exe',
              signature: validSig,
            },
          },
        },
        { requiredTargets: ['windows-x64'] },
      ),
    /missing required platform key "windows-x86_64-nsis"/,
  );
});

test('rejects secret key leaks, malformed/mismatched signatures, dangling .sig files, and tag mismatches', t => {
  // Secret key rejection (raw and base64-encoded)
  assert.throws(
    () => validateMinisignSignature('-----BEGIN PRIVATE KEY-----\nabc', '1.9.9'),
    /Refusing to embed secret key material/,
  );
  const encodedSecret = Buffer.from(
    'untrusted comment: minisign encrypted secret key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n',
    'utf8',
  ).toString('base64');
  assert.throws(
    () => validateMinisignSignature(encodedSecret, '1.9.9'),
    /Refusing to embed secret key material/,
  );

  // Malformed signature
  assert.throws(() => validateMinisignSignature('not!valid!base64', '1.9.9'), /valid base64/);
  assert.throws(
    () => validateMinisignSignature(Buffer.from('hello world').toString('base64'), '1.9.9'),
    /4-line minisign signature/,
  );

  // Signed version mismatch
  assert.throws(
    () => validateMinisignSignature(makeFakeSignature('1.9.8'), '1.9.9'),
    /signed for version "1\.9\.8".*does not match release version "1\.9\.9"/,
  );

  // Dangling signature without payload
  const danglingDir = tempDir(t);
  writeFileSync(join(danglingDir, 'Grapher_1.9.9_aarch64.app.tar.gz.sig'), makeFakeSignature('1.9.9'));
  assert.throws(
    () => generateUpdaterManifest({ assetsDir: danglingDir, tag: 'v1.9.9', log: () => {} }),
    /missing a non-empty payload file/,
  );

  // Unrecognized signature asset name
  const unknownDir = tempDir(t);
  writeFileSync(join(unknownDir, 'Grapher_1.9.9_unknown.bin'), 'bytes');
  writeFileSync(join(unknownDir, 'Grapher_1.9.9_unknown.bin.sig'), makeFakeSignature('1.9.9'));
  assert.throws(
    () => generateUpdaterManifest({ assetsDir: unknownDir, tag: 'v1.9.9', log: () => {} }),
    /Unrecognized Tauri updater signature file/,
  );

  // Tag vs explicit version mismatch
  assert.throws(
    () => generateUpdaterManifest({ assetsDir: unknownDir, tag: 'v2.0.0', version: '1.9.9', log: () => {} }),
    /does not match explicit version/,
  );

  assert.equal(normalizeVersion('v1.9.9'), '1.9.9');
  assert.throws(() => normalizeVersion('not-a-version'), /Invalid semantic version/);
  assert.equal(
    buildReleaseDownloadUrl('zhexusun10/grapher', 'v1.9.9', 'Grapher_1.9.9_x64-setup.exe'),
    'https://github.com/zhexusun10/grapher/releases/download/v1.9.9/Grapher_1.9.9_x64-setup.exe',
  );
  assert.equal(extractChangelogNotes('## [1.9.9] - 2026-11-19\n- Fixed bug\n## [1.9.8]\n- Old', '1.9.9'), '- Fixed bug');
  assert.equal(extractChangelogNotes('## [Unreleased]\n- WIP', '1.9.9'), null);
});

test('desktop-updater-manifest CLI works end-to-end for both signed and unsigned asset directories', t => {
  const dir = tempDir(t);
  const unsignedDir = join(dir, 'unsigned');
  const signedDir = join(dir, 'signed');
  mkdirSync(unsignedDir, { recursive: true });
  mkdirSync(signedDir, { recursive: true });
  writeFileSync(join(unsignedDir, 'Grapher_1.9.9_aarch64.dmg'), 'dmg');
  writeFileSync(join(signedDir, 'Grapher_1.9.9_aarch64.app.tar.gz'), 'tarball');
  writeFileSync(join(signedDir, 'Grapher_1.9.9_aarch64.app.tar.gz.sig'), makeFakeSignature('1.9.9'));
  const notesFile = join(dir, 'release-notes.md');
  writeFileSync(notesFile, '# Grapher v1.9.9\n\nCustom notes file.\n');

  const scriptPath = join(root, 'scripts', 'desktop-updater-manifest.mjs');

  const unsignedRun = spawnSync(
    process.execPath,
    [scriptPath, '--assets-dir', unsignedDir, '--output', join(unsignedDir, 'latest.json'), '--tag', 'v1.9.9'],
    { encoding: 'utf8' },
  );
  assert.equal(unsignedRun.status, 0, unsignedRun.stderr);
  assert.equal(existsSync(join(unsignedDir, 'latest.json')), false);
  assert.match(unsignedRun.stdout, /skipping latest\.json/i);

  const signedRun = spawnSync(
    process.execPath,
    [
      scriptPath,
      '--assets-dir',
      signedDir,
      '--output',
      join(signedDir, 'latest.json'),
      '--tag',
      'v1.9.9',
      '--repo',
      'zhexusun10/grapher',
      '--notes-file',
      notesFile,
      '--pub-date',
      '2026-11-19T12:00:00Z',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(signedRun.status, 0, signedRun.stderr);
  const manifest = JSON.parse(readFileSync(join(signedDir, 'latest.json'), 'utf8'));
  assert.equal(manifest.version, '1.9.9');
  assert.equal(manifest.notes, '# Grapher v1.9.9\n\nCustom notes file.');
  assert.ok(manifest.platforms['darwin-aarch64']);
  assert.ok(manifest.platforms['darwin-aarch64-app']);
});

test('desktop-build helpers guard tags, signing secrets, notarization config, and artifact names', t => {
  assert.equal(assertTagMatchesVersion('v1.9.9', '1.9.9'), '1.9.9');
  assert.throws(() => assertTagMatchesVersion('v2.0.0', '1.9.9'), /does not match synced desktop version/);

  assert.equal(hasUpdaterSigningKey({}), false);
  assert.equal(hasUpdaterSigningKey({ TAURI_SIGNING_PRIVATE_KEY: '   ' }), false);
  assert.equal(hasUpdaterSigningKey({ TAURI_SIGNING_PRIVATE_KEY: 'dW50cnVzdGVk' }), true);

  const dirtyEnv = {
    PATH: '/usr/bin',
    TAURI_SIGNING_PRIVATE_KEY: 'secret-key',
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '   ',
    APPLE_CERTIFICATE: 'cert-b64',
    APPLE_CERTIFICATE_PASSWORD: 'p12-password',
    APPLE_SIGNING_IDENTITY: 'Developer ID Application: Test (TEAM123456)',
    APPLE_PASSWORD: 'app-password',
    APPLE_API_KEY_P8: 'p8-secret',
  };
  const cleanBuild = sanitizedBuildEnv(dirtyEnv);
  assert.equal(cleanBuild.PATH, '/usr/bin');
  assert.equal(cleanBuild.TAURI_SIGNING_PRIVATE_KEY, undefined);
  assert.equal(cleanBuild.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, undefined);
  assert.equal(cleanBuild.APPLE_CERTIFICATE, undefined);
  assert.equal(cleanBuild.APPLE_SIGNING_IDENTITY, undefined);
  assert.equal(cleanBuild.APPLE_PASSWORD, undefined);
  assert.equal(cleanBuild.APPLE_API_KEY_P8, undefined);

  const signOnly = sanitizedBuildEnv(dirtyEnv, { allowUpdaterSigning: true });
  assert.equal(signOnly.TAURI_SIGNING_PRIVATE_KEY, 'secret-key');
  assert.equal(signOnly.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, undefined, 'blank password omitted');
  assert.equal(signOnly.APPLE_PASSWORD, undefined);

  // macOS notarization config stays null for ad-hoc signing or partial credentials
  const p8File = join(tempDir(t), 'AuthKey.p8');
  writeFileSync(p8File, '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n');
  const devId = 'Developer ID Application: Test (TEAM123456)';
  assert.equal(
    resolveMacosNotarizationConfig(
      { APPLE_API_KEY: 'KEY123', APPLE_API_ISSUER: 'ISSUER', APPLE_API_KEY_PATH: p8File },
      '-',
    ),
    null,
  );
  assert.equal(resolveMacosNotarizationConfig({ APPLE_API_KEY: 'KEY123' }, devId), null);
  assert.deepEqual(
    resolveMacosNotarizationConfig(
      { APPLE_API_KEY: 'KEY123', APPLE_API_ISSUER: 'ISSUER', APPLE_API_KEY_PATH: p8File },
      devId,
    ),
    { mode: 'api-key', keyId: 'KEY123', issuer: 'ISSUER', keyPath: p8File },
  );
  assert.deepEqual(
    resolveMacosNotarizationConfig(
      { APPLE_ID: 'dev@example.com', APPLE_PASSWORD: 'secret', APPLE_TEAM_ID: 'TEAM123456' },
      devId,
    ),
    { mode: 'apple-id', appleId: 'dev@example.com', password: 'secret', teamId: 'TEAM123456' },
  );

  // Distinct, collision-free per-target artifact names
  assert.deepEqual(desktopArtifactNames(DESKTOP_TARGETS['macos-arm64'], '1.9.9'), {
    installerName: 'Grapher_1.9.9_aarch64.dmg',
    updaterName: 'Grapher_1.9.9_aarch64.app.tar.gz',
    signatureName: 'Grapher_1.9.9_aarch64.app.tar.gz.sig',
  });
  assert.deepEqual(desktopArtifactNames(DESKTOP_TARGETS['macos-x64'], '1.9.9'), {
    installerName: 'Grapher_1.9.9_x64.dmg',
    updaterName: 'Grapher_1.9.9_x64.app.tar.gz',
    signatureName: 'Grapher_1.9.9_x64.app.tar.gz.sig',
  });
  assert.deepEqual(desktopArtifactNames(DESKTOP_TARGETS['windows-x64'], '1.9.9'), {
    installerName: 'Grapher_1.9.9_x64-setup.exe',
    updaterName: 'Grapher_1.9.9_x64-setup.exe',
    signatureName: 'Grapher_1.9.9_x64-setup.exe.sig',
  });
});

test('release workflow enforces least-privilege permissions, desktop + archive builds, safe secret handling, and published-release protection', () => {
  const workflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8');

  // Tag trigger and least-privilege permissions
  assert.match(workflow, /tags:\s*\n\s*-\s*'v\*'/);
  assert.match(workflow, /^permissions:\s*\n\s+contents:\s*read/m);
  const writePermMatches = workflow.match(/contents:\s*write/g) ?? [];
  assert.equal(writePermMatches.length, 1, 'only create-release job should request contents: write');

  // Retains existing relocatable archive outputs
  for (const artifact of [
    'grapher-linux-x64.tar.gz',
    'grapher-macos-arm64.tar.gz',
    'grapher-macos-x64.tar.gz',
    'grapher-windows-x64.zip',
  ]) {
    assert.ok(workflow.includes(artifact), `missing archive output: ${artifact}`);
  }

  // Separate Apple Silicon, Intel macOS, and Windows x64 desktop Tauri jobs
  assert.match(workflow, /os:\s*macos-15\s*\n\s*platform:\s*macos\s*\n\s*target:\s*macos-arm64/);
  assert.match(workflow, /os:\s*macos-15-intel\s*\n\s*platform:\s*macos\s*\n\s*target:\s*macos-x64/);
  assert.match(workflow, /os:\s*windows-latest\s*\n\s*platform:\s*windows\s*\n\s*target:\s*windows-x64/);
  assert.match(workflow, /node scripts\/desktop-build\.mjs/);

  // Reserves Tauri updater signing secrets and optional macOS signing/notarization secrets
  assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY:\s*\$\{\{\s*secrets\.TAURI_SIGNING_PRIVATE_KEY\s*\}\}/);
  assert.match(
    workflow,
    /TAURI_SIGNING_PRIVATE_KEY_PASSWORD:\s*\$\{\{\s*secrets\.TAURI_SIGNING_PRIVATE_KEY_PASSWORD\s*\}\}/,
  );
  assert.match(workflow, /if:\s*always\(\)\s*&&\s*matrix\.platform\s*==\s*'macos'/);

  // Never interpolate secrets directly inside shell run: scripts (only via env: mappings)
  for (const line of workflow.split(/\r?\n/)) {
    if (line.includes('secrets.')) {
      assert.match(
        line,
        /^\s+[A-Z0-9_]+:\s+.*\$\{\{.*secrets\./,
        `secret reference must be bound via env: mapping, not shell interpolation: ${line}`,
      );
    }
  }

  // Aggregated release job waits on both archive and desktop builds, generates latest.json with pubkey/completeness guardrails, and preserves published-release protection
  assert.match(workflow, /needs:\s*\n\s*-\s*build-release\s*\n\s*-\s*build-desktop/);
  assert.match(workflow, /node scripts\/desktop-updater-manifest\.mjs/);
  assert.match(workflow, /--tauri-conf src-tauri\/tauri\.conf\.json/);
  assert.match(workflow, /--require-pubkey/);
  assert.match(workflow, /--require-all-when-signed/);
  assert.match(workflow, /node scripts\/desktop-updater-manifest\.mjs \\\r?\n\s+--finalize-assets/);
  assert.match(workflow, /SHA256SUMS\.txt/);
  assert.match(workflow, /Refusing to modify a published release/);
  assert.match(workflow, /gh release create "\$RELEASE_TAG" --verify-tag --draft/);
  assert.match(workflow, /gh release upload "\$RELEASE_TAG" release-assets\/\* --clobber/);
});

test('consolidateReleaseAssets merges per-file checksums into SHA256SUMS.txt and prunes redundant .sig files', t => {
  const dir = tempDir(t);
  const assetsDir = join(dir, 'release-assets');
  mkdirSync(assetsDir, { recursive: true });

  const binaryAssets = [
    'Grapher_1.9.10_aarch64.app.tar.gz',
    'Grapher_1.9.10_aarch64.dmg',
    'Grapher_1.9.10_x64-setup.exe',
    'Grapher_1.9.10_x64.app.tar.gz',
    'Grapher_1.9.10_x64.dmg',
    'grapher-linux-x64.tar.gz',
    'grapher-macos-arm64.tar.gz',
    'grapher-macos-x64.tar.gz',
    'grapher-windows-x64.zip',
  ];
  for (const name of binaryAssets) {
    writeFileSync(join(assetsDir, name), `payload:${name}`);
    writeFileSync(join(assetsDir, `${name}.sha256`), `old  ${name}\n`);
  }
  for (const sigTarget of [
    'Grapher_1.9.10_aarch64.app.tar.gz',
    'Grapher_1.9.10_x64.app.tar.gz',
    'Grapher_1.9.10_x64-setup.exe',
  ]) {
    writeFileSync(join(assetsDir, `${sigTarget}.sig`), makeFakeSignature('1.9.10', sigTarget));
  }
  writeFileSync(join(assetsDir, 'latest.json'), '{"version":"1.9.10"}\n');

  const result = consolidateReleaseAssets(assetsDir, { log: () => {} });
  assert.equal(result.hashedFiles.length, 9);
  assert.equal(result.removed.length, 12);
  assert.deepEqual(result.remainingFiles, [
    ...binaryAssets,
    'SHA256SUMS.txt',
    'latest.json',
  ].sort((a, b) => a.localeCompare(b)));

  const sums = readFileSync(join(assetsDir, 'SHA256SUMS.txt'), 'utf8').trim().split('\n');
  assert.equal(sums.length, 9);
  for (const line of sums) {
    assert.match(line, /^[a-f0-9]{64}  [^\s]+$/);
  }
});
