// Build production Tauri v2 desktop installers:
// - macOS arm64 / x64: staged resources + inside-out nested Mach-O signing + optional notarization + `.dmg` + optional updater `.app.tar.gz` + `.sig`
// - Windows x64: staged resources + NSIS `.exe` installer + optional updater `.exe.sig`
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolchainEnv } from './cargo.mjs';
import { root } from './ensure-deps.mjs';
import { signMacosAppBundle } from './desktop-sign-macos.mjs';
import {
  hostTargetMatches,
  resolveDesktopTarget,
  sha256File,
  stageDesktopResources,
  verifyStagedRuntimeWithNode,
} from './desktop-stage.mjs';
import {
  verifyMinisignSignatureAgainstPayload,
} from './desktop-updater-manifest.mjs';
import {
  DEFAULT_WINDOWS_TIMESTAMP_URL,
  inspectWindowsSigningEnv,
  validateUpdaterSigningEnvironment,
} from './desktop-signing.mjs';

const UPDATER_SECRET_ENV_VARS = [
  'TAURI_SIGNING_PRIVATE_KEY',
  'TAURI_SIGNING_PRIVATE_KEY_PATH',
  'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
];

const APPLE_SECRET_ENV_VARS = [
  'APPLE_CERTIFICATE',
  'APPLE_CERTIFICATE_PASSWORD',
  'APPLE_API_KEY_P8',
  'APPLE_PASSWORD',
];

const WINDOWS_SECRET_ENV_VARS = [
  'WINDOWS_CERTIFICATE',
  'WINDOWS_CERTIFICATE_PASSWORD',
  'WINDOWS_SIGN_COMMAND',
];

export function readDesktopVersions(installationRoot = root) {
  const pkgVersion = JSON.parse(readFileSync(join(installationRoot, 'package.json'), 'utf8')).version;
  const tauriConf = JSON.parse(readFileSync(join(installationRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const cargoToml = readFileSync(join(installationRoot, 'src-tauri', 'Cargo.toml'), 'utf8');
  const cargoMatch = cargoToml.match(/^version\s*=\s*"([^"]+)"/m);
  const cargoVersion = cargoMatch?.[1] ?? null;
  return {
    packageJson: pkgVersion,
    tauriConf: tauriConf.version,
    cargoToml: cargoVersion,
  };
}

export function assertVersionsSynced(installationRoot = root) {
  const versions = readDesktopVersions(installationRoot);
  if (
    !versions.packageJson ||
    versions.packageJson !== versions.tauriConf ||
    versions.packageJson !== versions.cargoToml
  ) {
    throw new Error(
      `Desktop version mismatch: package.json=${versions.packageJson}, tauri.conf.json=${versions.tauriConf}, src-tauri/Cargo.toml=${versions.cargoToml}`,
    );
  }
  return versions.packageJson;
}

export function assertTagMatchesVersion(tag, expectedVersion) {
  const cleanedTag = String(tag ?? '').trim();
  if (!cleanedTag) {
    throw new Error('Release tag must not be empty.');
  }
  const normalizedTagVersion = cleanedTag.replace(/^v/i, '');
  const normalizedExpected = String(expectedVersion ?? '').trim().replace(/^v/i, '');
  if (!normalizedExpected || normalizedTagVersion !== normalizedExpected) {
    throw new Error(
      `Release tag "${cleanedTag}" (version ${normalizedTagVersion}) does not match synced desktop version "${normalizedExpected}". Update package.json, src-tauri/tauri.conf.json, and src-tauri/Cargo.toml before tagging.`,
    );
  }
  return normalizedExpected;
}

export function hasUpdaterSigningKey(env = process.env) {
  const key = typeof env?.TAURI_SIGNING_PRIVATE_KEY === 'string' ? env.TAURI_SIGNING_PRIVATE_KEY.trim() : '';
  const keyPath =
    typeof env?.TAURI_SIGNING_PRIVATE_KEY_PATH === 'string' ? env.TAURI_SIGNING_PRIVATE_KEY_PATH.trim() : '';
  return Boolean(key || (keyPath && existsSync(keyPath)));
}

/**
 * Validate updater signing configuration before compiling or signing desktop artifacts:
 * - Always validates any configured public key (`GRAPHER_UPDATER_PUBKEY`,
 *   `TAURI_UPDATER_PUBKEY`, or `plugins.updater.pubkey` in `tauri.conf.json`).
 * - When `TAURI_SIGNING_PRIVATE_KEY` is present, requires a valid matching public key
 *   AND cryptographically verifies that the private key matches the configured public key
 *   before spending time compiling or bundling.
 * - When `TAURI_SIGNING_PRIVATE_KEY` is absent, explicitly permits unsigned installer-only builds.
 */
export function validateUpdaterSigningConfig({
  env = process.env,
  tauriConfPath = join(root, 'src-tauri', 'tauri.conf.json'),
} = {}) {
  const checked = validateUpdaterSigningEnvironment({ env, tauriConfPath });
  return {
    signingEnabled: checked.signingEnabled,
    pubkey: checked.pubkey,
    pubkeySource: checked.pubkeySource,
    keyIdHex: checked.keyIdHex,
    keypairVerified: checked.keypairVerified,
  };
}

export function verifySignedUpdaterArtifact(artifactPath, sigPath, { pubkey, version }) {
  if (!existsSync(sigPath) || !readFileSync(sigPath, 'utf8').trim()) {
    throw new Error(`Expected Tauri updater signature file was not created: ${sigPath}`);
  }
  if (!pubkey) {
    throw new Error(
      `Cannot verify updater signature ${basename(sigPath)} without a configured updater public key.`,
    );
  }
  return verifyMinisignSignatureAgainstPayload({
    payloadBytes: readFileSync(artifactPath),
    signatureText: readFileSync(sigPath, 'utf8'),
    pubkeyText: pubkey,
    expectedVersion: version,
    label: basename(sigPath),
  });
}

export function sanitizedBuildEnv(
  baseEnv = process.env,
  { allowUpdaterSigning = false, allowAppleSigning = false, allowWindowsSigning = false } = {},
) {
  const env = { ...baseEnv };
  if (!allowUpdaterSigning) {
    for (const key of UPDATER_SECRET_ENV_VARS) delete env[key];
  } else {
    for (const key of UPDATER_SECRET_ENV_VARS) {
      if (typeof env[key] === 'string' && !env[key].trim()) {
        delete env[key];
      }
    }
  }
  if (!allowAppleSigning) {
    for (const key of APPLE_SECRET_ENV_VARS) delete env[key];
    delete env.APPLE_SIGNING_IDENTITY;
  }
  if (!allowWindowsSigning) {
    for (const key of WINDOWS_SECRET_ENV_VARS) delete env[key];
  }
  return env;
}

export function resolveWindowsSigningConfig(env = process.env) {
  const inspected = inspectWindowsSigningEnv(env);
  if (inspected.errors.length > 0) {
    throw new Error(inspected.errors.join(' '));
  }
  if (inspected.mode === 'sign-command') {
    return {
      mode: 'sign-command',
      signCommand: env.WINDOWS_SIGN_COMMAND.trim(),
      timestampUrl: inspected.timestampUrl,
    };
  }
  if (inspected.mode === 'thumbprint') {
    const thumbprint = env.WINDOWS_CERTIFICATE_THUMBPRINT.trim()
      .replace(/[\s:]+/g, '')
      .toUpperCase();
    return {
      mode: 'thumbprint',
      certificateThumbprint: thumbprint,
      thumbprintPreview: inspected.thumbprintPreview,
      digestAlgorithm: 'sha256',
      timestampUrl: inspected.timestampUrl || DEFAULT_WINDOWS_TIMESTAMP_URL,
      tsp: true,
    };
  }
  return null;
}

/**
 * Build the `--config` JSON override passed to `tauri build`:
 * - Always disables `beforeBuildCommand` (staging already ran) and `createUpdaterArtifacts`
 *   (we sign updater payloads explicitly after native code-signing/notarization).
 * - Embeds any resolved updater public key into `plugins.updater.pubkey` so both
 *   `tauri::generate_context!()` and `option_env!("GRAPHER_UPDATER_PUBKEY")` agree.
 * - On Windows, injects optional Authenticode signing config (`certificateThumbprint` or
 *   `signCommand`) so `Grapher.exe` and the NSIS `-setup.exe` are Authenticode-signed
 *   before the Tauri updater minisign signature is computed over the final `.exe`.
 */
export function buildTauriConfigOverride({ pubkey = null, windowsSigning = null } = {}) {
  const override = {
    build: { beforeBuildCommand: '' },
    bundle: { createUpdaterArtifacts: false },
  };
  if (pubkey) {
    override.plugins = {
      updater: {
        pubkey,
      },
    };
  }
  if (windowsSigning) {
    if (windowsSigning.mode === 'sign-command') {
      override.bundle.windows = {
        signCommand: windowsSigning.signCommand,
      };
    } else if (windowsSigning.mode === 'thumbprint') {
      override.bundle.windows = {
        certificateThumbprint: windowsSigning.certificateThumbprint,
        digestAlgorithm: windowsSigning.digestAlgorithm ?? 'sha256',
        timestampUrl: windowsSigning.timestampUrl ?? DEFAULT_WINDOWS_TIMESTAMP_URL,
        tsp: windowsSigning.tsp ?? true,
      };
    }
  }
  return override;
}

export function resolveMacosNotarizationConfig(
  env = process.env,
  signingIdentity = env?.APPLE_SIGNING_IDENTITY || '-',
) {
  const normalizedIdentity = typeof signingIdentity === 'string' ? signingIdentity.trim() : '';
  if (!normalizedIdentity || normalizedIdentity === '-') {
    return null;
  }

  const apiKey = typeof env?.APPLE_API_KEY === 'string' ? env.APPLE_API_KEY.trim() : '';
  const apiIssuer = typeof env?.APPLE_API_ISSUER === 'string' ? env.APPLE_API_ISSUER.trim() : '';
  const apiKeyPath = typeof env?.APPLE_API_KEY_PATH === 'string' ? env.APPLE_API_KEY_PATH.trim() : '';
  if (apiKey && apiIssuer && apiKeyPath && existsSync(apiKeyPath)) {
    return { mode: 'api-key', keyId: apiKey, issuer: apiIssuer, keyPath: apiKeyPath };
  }

  const appleId = typeof env?.APPLE_ID === 'string' ? env.APPLE_ID.trim() : '';
  const applePassword = typeof env?.APPLE_PASSWORD === 'string' ? env.APPLE_PASSWORD.trim() : '';
  const teamId = typeof env?.APPLE_TEAM_ID === 'string' ? env.APPLE_TEAM_ID.trim() : '';
  if (appleId && applePassword && teamId) {
    return { mode: 'apple-id', appleId, password: applePassword, teamId };
  }

  return null;
}

export function desktopArtifactNames(target, version) {
  const normalizedVersion = String(version).trim().replace(/^v/i, '');
  if (target.platform === 'darwin') {
    const archLabel = target.arch === 'arm64' ? 'aarch64' : 'x64';
    const installerName = `Grapher_${normalizedVersion}_${archLabel}.dmg`;
    const updaterName = `Grapher_${normalizedVersion}_${archLabel}.app.tar.gz`;
    return {
      installerName,
      updaterName,
      signatureName: `${updaterName}.sig`,
    };
  }
  const installerName = `Grapher_${normalizedVersion}_x64-setup.exe`;
  return {
    installerName,
    updaterName: installerName,
    signatureName: `${installerName}.sig`,
  };
}

export function writeSha256File(filePath) {
  const digest = sha256File(filePath);
  const shaPath = `${filePath}.sha256`;
  writeFileSync(shaPath, `${digest}  ${basename(filePath)}\n`);
  return shaPath;
}

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

function runTauriCli(args, { env, cwd = root } = {}) {
  const { command, prefixArgs } = tauriCliEntry(root);
  execFileSync(command, [...prefixArgs, ...args], {
    cwd,
    env,
    stdio: 'inherit',
  });
}

function tauriTargetBundleDir(target, env = process.env) {
  const base = env.CARGO_TARGET_DIR
    ? resolve(root, env.CARGO_TARGET_DIR)
    : join(root, 'src-tauri', 'target');
  const tripleDir = join(base, target.rustTriple, 'release', 'bundle');
  const hostDir = join(base, 'release', 'bundle');
  return hostTargetMatches(target) && existsSync(hostDir) ? hostDir : tripleDir;
}

export const MACOS_DMG_FORMAT = 'ULMO';

function formatFileSizeMb(filePath) {
  return `${(statSync(filePath).size / (1024 * 1024)).toFixed(1)} MB`;
}

function createSignedDmg(appPath, dmgPath, signingIdentity) {
  const staging = mkdtempSync(join(tmpdir(), 'grapher-dmg-'));
  try {
    cpSync(appPath, join(staging, 'Grapher.app'), { recursive: true, verbatimSymlinks: true });
    symlinkSync('/Applications', join(staging, 'Applications'));
    mkdirSync(dirname(dmgPath), { recursive: true });
    rmSync(dmgPath, { force: true });
    execFileSync(
      'hdiutil',
      ['create', '-volname', 'Grapher', '-srcfolder', staging, '-ov', '-format', MACOS_DMG_FORMAT, dmgPath],
      { stdio: 'inherit' },
    );
    if (signingIdentity && signingIdentity !== '-') {
      execFileSync(
        'codesign',
        ['--force', '--timestamp', '--sign', signingIdentity, dmgPath],
        { stdio: 'inherit' },
      );
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Package a signed (and optionally stapled) macOS `.app` bundle into the exact
 * tar.gz layout expected by `tauri-plugin-updater` (`Grapher.app/Contents/...`,
 * without leading `./` and without AppleDouble `._*` resource forks).
 */
export function createMacosUpdaterTarball(appPath, tarballPath) {
  mkdirSync(dirname(tarballPath), { recursive: true });
  rmSync(tarballPath, { force: true });
  execFileSync(
    'tar',
    ['-czf', tarballPath, '-C', dirname(appPath), basename(appPath)],
    {
      env: { ...process.env, COPYFILE_DISABLE: '1', GZIP: '-9' },
      stdio: 'inherit',
    },
  );
  return tarballPath;
}

function notarytoolAuthArgs(notarizationConfig) {
  if (notarizationConfig.mode === 'api-key') {
    return [
      '--key',
      notarizationConfig.keyPath,
      '--key-id',
      notarizationConfig.keyId,
      '--issuer',
      notarizationConfig.issuer,
    ];
  }
  return [
    '--apple-id',
    notarizationConfig.appleId,
    '--team-id',
    notarizationConfig.teamId,
    '--password',
    notarizationConfig.password,
  ];
}

function submitToNotarytool(submissionPath, notarizationConfig) {
  const authArgs = notarytoolAuthArgs(notarizationConfig);
  const args = ['notarytool', 'submit', submissionPath, '--wait', '--output-format', 'json', ...authArgs];
  const raw = execFileSync('xcrun', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Fall back to printing raw output if Apple changed formatting.
  }
  if (!parsed) {
    console.log(raw);
    return;
  }
  console.log(
    `[desktop:build] Apple notarization result for ${basename(submissionPath)}: status=${parsed.status} id=${parsed.id}`,
  );
  if (parsed.status !== 'Accepted') {
    let details = '';
    if (parsed.id) {
      try {
        details = execFileSync('xcrun', ['notarytool', 'log', parsed.id, ...authArgs], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
      } catch {
        // Ignore secondary log fetch errors; primary status error still fails the build.
      }
    }
    throw new Error(
      `Apple notarization failed for ${basename(submissionPath)} (status=${parsed.status}, id=${parsed.id ?? 'unknown'}).${details ? `\n${details}` : ''}`,
    );
  }
}

function notarizeAndStapleMacosApp(appPath, notarizationConfig) {
  const tempDir = mkdtempSync(join(tmpdir(), 'grapher-notarize-'));
  const zipPath = join(tempDir, `${basename(appPath)}.zip`);
  try {
    console.log(`[desktop:build] Notarizing ${basename(appPath)} (${notarizationConfig.mode})...`);
    execFileSync('ditto', ['-c', '-k', '--keepParent', appPath, zipPath], { stdio: 'inherit' });
    submitToNotarytool(zipPath, notarizationConfig);
    console.log(`[desktop:build] Stapling notarization ticket to ${basename(appPath)}...`);
    execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function notarizeAndStapleMacosDmg(dmgPath, notarizationConfig) {
  console.log(`[desktop:build] Notarizing ${basename(dmgPath)} (${notarizationConfig.mode})...`);
  submitToNotarytool(dmgPath, notarizationConfig);
  console.log(`[desktop:build] Stapling notarization ticket to ${basename(dmgPath)}...`);
  execFileSync('xcrun', ['stapler', 'staple', dmgPath], { stdio: 'inherit' });
}

function signUpdaterArtifact(artifactPath, version, baseEnv, pubkey) {
  const sigPath = `${artifactPath}.sig`;
  rmSync(sigPath, { force: true });
  const signEnv = toolchainEnv(sanitizedBuildEnv(baseEnv, { allowUpdaterSigning: true }));
  console.log(`[desktop:build] Signing Tauri updater artifact ${basename(artifactPath)} for v${version}...`);
  runTauriCli(['signer', 'sign', '--app-version', version, artifactPath], {
    cwd: root,
    env: signEnv,
  });
  const verified = verifySignedUpdaterArtifact(artifactPath, sigPath, { pubkey, version });
  console.log(
    `[desktop:build] Verified ${basename(sigPath)} against configured public key ${verified.keyIdHex} (v${verified.signedVersion}).`,
  );
  return sigPath;
}

function locateWindowsNsisInstaller(nsisDir, expectedName) {
  const exact = join(nsisDir, expectedName);
  if (existsSync(exact)) return exact;
  if (!existsSync(nsisDir)) {
    throw new Error(`Windows NSIS bundle directory does not exist: ${nsisDir}`);
  }
  const candidates = readdirSync(nsisDir).filter(name => name.toLowerCase().endsWith('.exe'));
  if (candidates.length === 1) {
    return join(nsisDir, candidates[0]);
  }
  throw new Error(
    `Could not uniquely locate Windows NSIS installer in ${nsisDir} (expected ${expectedName}; found: ${candidates.join(', ') || 'none'}).`,
  );
}

function exportDesktopArtifacts(outputDir, { installerPath, updaterPath, signaturePath, names }) {
  const resolvedOut = resolve(outputDir);
  rmSync(resolvedOut, { recursive: true, force: true });
  mkdirSync(resolvedOut, { recursive: true });
  const outputFiles = [];

  const exportedInstaller = join(resolvedOut, names.installerName);
  cpSync(installerPath, exportedInstaller);
  outputFiles.push(exportedInstaller, writeSha256File(exportedInstaller));

  if (updaterPath && updaterPath !== installerPath) {
    const exportedUpdater = join(resolvedOut, names.updaterName);
    cpSync(updaterPath, exportedUpdater);
    outputFiles.push(exportedUpdater, writeSha256File(exportedUpdater));
  }

  if (signaturePath) {
    const exportedSig = join(resolvedOut, names.signatureName);
    cpSync(signaturePath, exportedSig);
    outputFiles.push(exportedSig);
  }

  console.log(
    `[desktop:build] Exported ${outputFiles.length} artifact file(s) to ${resolvedOut}: ${outputFiles.map(file => basename(file)).join(', ')}`,
  );
  return outputFiles;
}

export async function buildDesktopBundle({
  targetSpec = null,
  skipStage = false,
  skipBuild = false,
  verifyTag = null,
  outputDir = null,
  explicitNodeBinary = process.env.GRAPHER_DESKTOP_NODE_BINARY || null,
  signingIdentity = process.env.APPLE_SIGNING_IDENTITY || '-',
  env: baseEnv = process.env,
} = {}) {
  const version = assertVersionsSynced(root);
  if (verifyTag) {
    assertTagMatchesVersion(verifyTag, version);
  }
  const target = resolveDesktopTarget(targetSpec);
  if (target.platform !== process.platform) {
    throw new Error(
      `Target ${target.id} requires building on ${target.platform} (current host: ${process.platform}).`,
    );
  }

  const normalizedIdentity = typeof signingIdentity === 'string' && signingIdentity.trim()
    ? signingIdentity.trim()
    : '-';
  const buildEnv = toolchainEnv(sanitizedBuildEnv(baseEnv));
  const updaterSigning = validateUpdaterSigningConfig({
    env: baseEnv,
    tauriConfPath: join(root, 'src-tauri', 'tauri.conf.json'),
  });
  const updaterSigningEnabled = updaterSigning.signingEnabled;
  if (updaterSigning.pubkey) {
    // Ensure the compiled desktop binary embeds the exact validated public key via
    // both `option_env!("GRAPHER_UPDATER_PUBKEY")` in `src-tauri/src/lib.rs` and
    // Tauri's `--config` override below.
    buildEnv.GRAPHER_UPDATER_PUBKEY = updaterSigning.pubkey;
  }
  const windowsSigning = target.platform === 'win32' ? resolveWindowsSigningConfig(baseEnv) : null;
  const names = desktopArtifactNames(target, version);

  if (updaterSigningEnabled) {
    console.log(
      `[desktop:build] Tauri updater signing enabled (key ID ${updaterSigning.keyIdHex}, pubkey source: ${updaterSigning.pubkeySource}).`,
    );
  } else {
    console.log(
      `[desktop:build] Tauri updater signing disabled (unsigned installer-only mode; embedded pubkey: ${updaterSigning.keyIdHex ? `${updaterSigning.keyIdHex} from ${updaterSigning.pubkeySource}` : 'none'}).`,
    );
  }

  if (!skipStage) {
    await stageDesktopResources({
      targetSpec: target.id,
      skipBuild,
      explicitNodeBinary,
      env: buildEnv,
    });
  }

  const tauriConfigOverrideObj = buildTauriConfigOverride({
    pubkey: updaterSigning.pubkey,
    windowsSigning,
  });
  const configTempDir = mkdtempSync(join(tmpdir(), 'grapher-tauri-config-'));
  const tauriConfigOverridePath = join(configTempDir, 'tauri.override.json');
  writeFileSync(tauriConfigOverridePath, `${JSON.stringify(tauriConfigOverrideObj, null, 2)}\n`, {
    mode: 0o600,
  });

  try {
    if (target.platform === 'darwin') {
      // Build Grapher.app first without Tauri's raw codesign pass, then apply
      // inside-out nested Mach-O signing (Node, grapher, native addons), optional
      // Apple notarization/stapling, and finally package `.dmg` + optional updater `.app.tar.gz`.
      const args = ['build', '--bundles', 'app', '--config', tauriConfigOverridePath];
      if (!hostTargetMatches(target)) {
        args.push('--target', target.rustTriple);
      }
      console.log(`[desktop:build] Building macOS .app bundle for ${target.id}...`);
      runTauriCli(args, { cwd: root, env: buildEnv });

      const bundleDir = tauriTargetBundleDir(target, buildEnv);
      const appPath = join(bundleDir, 'macos', 'Grapher.app');
      signMacosAppBundle(appPath, { identity: normalizedIdentity });

      if (hostTargetMatches(target)) {
        const bundledRuntime = join(appPath, 'Contents', 'Resources', 'runtime');
        const bundledNode = join(appPath, 'Contents', 'Resources', target.nodeRelPath);
        console.log('[desktop:build] Verifying bundled Grapher.app runtime with bundled Node...');
        verifyStagedRuntimeWithNode(bundledNode, bundledRuntime, buildEnv);
      }

      const notarizationConfig = resolveMacosNotarizationConfig(baseEnv, normalizedIdentity);
      if (notarizationConfig) {
        notarizeAndStapleMacosApp(appPath, notarizationConfig);
      } else if (normalizedIdentity === '-') {
        console.log(
          '[desktop:build] APPLE_SIGNING_IDENTITY is not set; using ad-hoc macOS signing and skipping Apple notarization.',
        );
      } else {
        console.log(
          '[desktop:build] Apple notarization credentials are not configured; skipping macOS notarization.',
        );
      }

      const dmgPath = join(bundleDir, 'dmg', names.installerName);
      console.log(`[desktop:build] Creating macOS .dmg installer at ${dmgPath} (${MACOS_DMG_FORMAT})...`);
      createSignedDmg(appPath, dmgPath, normalizedIdentity);
      if (notarizationConfig) {
        notarizeAndStapleMacosDmg(dmgPath, notarizationConfig);
      }
      console.log(`[desktop:build] Built ${dmgPath} (${formatFileSizeMb(dmgPath)})`);

      let updaterPath = null;
      let signaturePath = null;
      if (updaterSigningEnabled) {
        updaterPath = join(bundleDir, 'macos', names.updaterName);
        console.log(`[desktop:build] Creating macOS updater archive at ${updaterPath}...`);
        createMacosUpdaterTarball(appPath, updaterPath);
        console.log(`[desktop:build] Built ${updaterPath} (${formatFileSizeMb(updaterPath)})`);
        signaturePath = signUpdaterArtifact(updaterPath, version, baseEnv, updaterSigning.pubkey);
      } else {
        console.log(
          `[desktop:build] TAURI_SIGNING_PRIVATE_KEY is not set; skipping Tauri updater archive/signature generation for ${target.id}.`,
        );
      }

      const outputFiles = outputDir
        ? exportDesktopArtifacts(outputDir, { installerPath: dmgPath, updaterPath, signaturePath, names })
        : [];
      return {
        target,
        version,
        appPath,
        installerPath: dmgPath,
        updaterPath,
        signaturePath,
        outputFiles,
      };
    }

    // Windows NSIS `.exe` bundle.
    if (windowsSigning?.mode === 'thumbprint') {
      console.log(
        `[desktop:build] Windows Authenticode signing enabled via certificate thumbprint (${windowsSigning.thumbprintPreview}, SHA-256 + RFC 3161 timestamp ${windowsSigning.timestampUrl}).`,
      );
    } else if (windowsSigning?.mode === 'sign-command') {
      console.log('[desktop:build] Windows Authenticode signing enabled via custom WINDOWS_SIGN_COMMAND.');
    } else {
      console.log(
        '[desktop:build] Optional Windows Authenticode signing is not configured; NSIS installer will be unsigned (Windows SmartScreen warnings expected on downloaded builds).',
      );
    }
    const args = ['build', '--bundles', 'nsis', '--config', tauriConfigOverridePath];
    if (!hostTargetMatches(target)) {
      args.push('--target', target.rustTriple);
    }
    console.log(`[desktop:build] Building Windows NSIS installer for ${target.id}...`);
    runTauriCli(args, { cwd: root, env: buildEnv });
    const bundleDir = tauriTargetBundleDir(target, buildEnv);
    const nsisDir = join(bundleDir, 'nsis');
    const installerPath = locateWindowsNsisInstaller(nsisDir, names.installerName);
    console.log(`[desktop:build] Built Windows NSIS installer at ${installerPath} (${formatFileSizeMb(installerPath)})`);

    let updaterPath = null;
    let signaturePath = null;
    if (updaterSigningEnabled) {
      updaterPath = installerPath;
      signaturePath = signUpdaterArtifact(installerPath, version, baseEnv, updaterSigning.pubkey);
    } else {
      console.log(
        `[desktop:build] TAURI_SIGNING_PRIVATE_KEY is not set; skipping Tauri updater signature generation for ${target.id}.`,
      );
    }

    const outputFiles = outputDir
      ? exportDesktopArtifacts(outputDir, { installerPath, updaterPath, signaturePath, names })
      : [];
    return {
      target,
      version,
      installerDir: nsisDir,
      installerPath,
      updaterPath,
      signaturePath,
      outputFiles,
    };
  } finally {
    rmSync(configTempDir, { recursive: true, force: true });
  }
}

function parseCliArgs(argv) {
  const options = {
    targetSpec: null,
    skipStage: false,
    skipBuild: false,
    verifyTag: null,
    outputDir: null,
    explicitNodeBinary: process.env.GRAPHER_DESKTOP_NODE_BINARY || null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--target' && argv[i + 1]) {
      options.targetSpec = argv[++i];
    } else if (arg === '--skip-stage') {
      options.skipStage = true;
    } else if (arg === '--skip-build') {
      options.skipBuild = true;
    } else if (arg === '--verify-tag' && argv[i + 1]) {
      options.verifyTag = argv[++i];
    } else if (arg === '--output-dir' && argv[i + 1]) {
      options.outputDir = argv[++i];
    } else if (arg === '--node-binary' && argv[i + 1]) {
      options.explicitNodeBinary = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node scripts/desktop-build.mjs [--target macos-arm64|macos-x64|windows-x64] [--skip-stage] [--skip-build] [--verify-tag <tag>] [--output-dir <dir>] [--node-binary <path>]',
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    await buildDesktopBundle(options);
  } catch (error) {
    console.error(`[desktop:build] ${error.message}`);
    process.exitCode = 1;
  }
}
