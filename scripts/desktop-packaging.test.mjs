import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { root } from './ensure-deps.mjs';
import { assertVersionsSynced } from './desktop-build.mjs';
import {
  entitlementsForBinary,
  findMachOBinaries,
  isMachOBuffer,
} from './desktop-sign-macos.mjs';
import {
  assertMinimumNodeVersion,
  dereferenceSymlinksInPlace,
  DESKTOP_TARGETS,
  ensureBundleableGitMetadata,
  findRemainingSymlinks,
  PINNED_NODE_VERSION,
  resolveDesktopTarget,
} from './desktop-stage.mjs';
import { buildDesktopIconSvg, REQUIRED_DESKTOP_ICONS } from './desktop-icons.mjs';
import { inflateSync } from 'node:zlib';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'grapher-desktop-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('Tauri v2 config enforces least privilege, synced versions, and .dmg / NSIS bundles', () => {
  const version = assertVersionsSynced(root);
  assert.match(version, /^\d+\.\d+\.\d+/);

  const conf = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  assert.equal(conf.productName, 'Grapher');
  assert.equal(conf.identifier, 'io.github.zhexusun10.grapher');
  assert.equal(conf.app.withGlobalTauri, false);
  const mainWindow = conf.app.windows.find(win => win.label === 'main');
  assert.ok(mainWindow, 'main window must be configured');
  assert.equal(mainWindow.title, 'Grapher');
  assert.equal(mainWindow.titleBarStyle, 'Overlay');
  assert.equal(mainWindow.hiddenTitle, true);
  assert.equal(conf.build.devUrl, 'http://127.0.0.1:1420');
  assert.equal(conf.build.frontendDist, '../dist');

  // Verify the macOS overlay titlebar keys and enum value against the installed Tauri v2 schema.
  const schema = JSON.parse(
    readFileSync(join(root, 'node_modules', '@tauri-apps', 'cli', 'config.schema.json'), 'utf8'),
  );
  const windowProps = schema.definitions.WindowConfig.properties;
  assert.ok(windowProps.titleBarStyle, 'WindowConfig schema must define titleBarStyle');
  assert.equal(windowProps.hiddenTitle.type, 'boolean');
  const titleBarStyles = schema.definitions.TitleBarStyle.oneOf.flatMap(entry => entry.enum ?? []);
  assert.ok(
    titleBarStyles.includes(mainWindow.titleBarStyle),
    `Expected titleBarStyle "${mainWindow.titleBarStyle}" in schema enum [${titleBarStyles.join(', ')}]`,
  );
  assert.ok(conf.app.security.csp.includes('http://127.0.0.1:*'));
  assert.deepEqual(conf.bundle.targets, ['app', 'dmg', 'nsis']);
  assert.equal(conf.bundle.resources['resources/runtime'], 'runtime');
  assert.equal(conf.bundle.resources['resources/node'], 'node');
  assert.equal(conf.bundle.macOS.hardenedRuntime, true);
  assert.equal(conf.bundle.macOS.entitlements, 'Entitlements.plist');
  assert.equal(conf.bundle.windows.nsis.installMode, 'currentUser');
  // Base config keeps createUpdaterArtifacts off so unsigned local/CI builds succeed without a private key.
  assert.equal(conf.bundle.createUpdaterArtifacts, false);
  assert.deepEqual(conf.plugins?.updater?.endpoints, [
    'https://github.com/zhexusun10/grapher/releases/latest/download/latest.json',
  ]);
  assert.equal(typeof conf.plugins?.updater?.pubkey, 'string');
  assert.doesNotMatch(conf.plugins.updater.pubkey, /PRIVATE KEY|encrypted secret key/i);
  assert.equal(conf.plugins?.updater?.requireSignedVersion, true);
  assert.equal(conf.plugins?.updater?.windows?.installMode, 'passive');
});

test('Tauri v2 capability grants least-privilege backend_url, autostart, updater, and restart permissions on the main window', () => {
  const capability = JSON.parse(
    readFileSync(join(root, 'src-tauri', 'capabilities', 'default.json'), 'utf8'),
  );
  assert.equal(capability.local, true);
  assert.deepEqual(capability.windows, ['main']);
  assert.deepEqual(capability.permissions, [
    'allow-backend-url',
    'allow-git-bootstrap',
    'core:app:allow-version',
    'core:resources:allow-close',
    'autostart:default',
    'updater:default',
    'process:allow-restart',
  ]);
  for (const perm of capability.permissions) {
    assert.doesNotMatch(perm, /^(?:fs|shell|opener|dialog):/i, `unexpected broad permission: ${perm}`);
  }

  const permission = readFileSync(
    join(root, 'src-tauri', 'permissions', 'allow-backend-url.toml'),
    'utf8',
  );
  assert.match(permission, /identifier\s*=\s*"allow-backend-url"/);
  assert.match(permission, /commands\.allow\s*=\s*\["backend_url"\]/);

  const gitBootstrapPermission = readFileSync(
    join(root, 'src-tauri', 'permissions', 'allow-git-bootstrap.toml'),
    'utf8',
  );
  assert.match(gitBootstrapPermission, /identifier\s*=\s*"allow-git-bootstrap"/);
  assert.match(
    gitBootstrapPermission,
    /commands\.allow\s*=\s*\["git_bootstrap_status",\s*"retry_git_bootstrap"\]/,
  );

  const macosWindowCap = JSON.parse(
    readFileSync(join(root, 'src-tauri', 'capabilities', 'macos-window.json'), 'utf8'),
  );
  assert.equal(macosWindowCap.local, true);
  assert.deepEqual(macosWindowCap.platforms, ['macOS']);
  assert.deepEqual(macosWindowCap.windows, ['main']);
  assert.deepEqual(macosWindowCap.permissions, [
    'core:window:allow-start-dragging',
    'core:window:allow-internal-toggle-maximize',
    'core:window:allow-is-fullscreen',
  ]);

  const windowsWindowCap = JSON.parse(
    readFileSync(join(root, 'src-tauri', 'capabilities', 'windows-window.json'), 'utf8'),
  );
  assert.equal(windowsWindowCap.local, true);
  assert.deepEqual(windowsWindowCap.platforms, ['windows']);
  assert.deepEqual(windowsWindowCap.windows, ['main']);
  assert.deepEqual(windowsWindowCap.permissions, [
    'core:window:allow-start-dragging',
    'core:window:allow-internal-toggle-maximize',
    'core:window:allow-minimize',
    'core:window:allow-toggle-maximize',
    'core:window:allow-is-maximized',
    'core:window:allow-is-fullscreen',
    'core:window:allow-close',
  ]);
});

function readPngInfo(filePath) {
  const buf = readFileSync(filePath);
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${filePath} must be PNG`);
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idatChunks = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    }
    offset += 12 + length;
  }
  return { width, height, colorType, idat: Buffer.concat(idatChunks) };
}

function sampleRgbaPngPixel(info, targetX, targetY) {
  assert.equal(info.colorType, 6, 'expected 8-bit RGBA PNG');
  const raw = inflateSync(info.idat);
  const stride = info.width * 4;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y <= targetY; y++) {
    const filter = raw[y * (stride + 1)];
    const row = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? row[i - 4] : 0;
      const b = prev[i];
      const c = i >= 4 ? prev[i - 4] : 0;
      if (filter === 1) row[i] = (row[i] + a) & 0xff;
      else if (filter === 2) row[i] = (row[i] + b) & 0xff;
      else if (filter === 3) row[i] = (row[i] + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        row[i] = (row[i] + pr) & 0xff;
      }
    }
    if (y === targetY) {
      return [row[targetX * 4], row[targetX * 4 + 1], row[targetX * 4 + 2], row[targetX * 4 + 3]];
    }
    prev = row;
  }
  throw new Error('targetY out of bounds');
}

test('desktop icon assets are reproducibly derived from assets/icon-dots.svg with a white canvas and valid Tauri bundle formats', () => {
  const webSvg = readFileSync(join(root, 'assets', 'icon-dots.svg'), 'utf8');
  const generatedSvg = buildDesktopIconSvg(webSvg);
  assert.match(generatedSvg, /fill="#FFFFFF"/);
  assert.match(generatedSvg, /stroke="#4A4A4A"/);
  assert.equal((generatedSvg.match(/<path\b/gu) ?? []).length, 4);
  // 1 white rounded-square tile + 4 graph node rects = 5 <rect> elements.
  assert.equal((generatedSvg.match(/<rect\b/gu) ?? []).length, 5);

  const conf = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const iconsDir = join(root, 'src-tauri', 'icons');
  for (const iconRef of conf.bundle.icon) {
    assert.ok(
      REQUIRED_DESKTOP_ICONS.includes(iconRef.replace(/^icons\//, '')),
      `bundle icon ${iconRef} must be covered by REQUIRED_DESKTOP_ICONS`,
    );
  }

  const expectedPngSizes = {
    '32x32.png': 32,
    '128x128.png': 128,
    '128x128@2x.png': 256,
    'icon.png': 512,
  };
  for (const [fileName, size] of Object.entries(expectedPngSizes)) {
    const info = readPngInfo(join(iconsDir, fileName));
    assert.equal(info.width, size, `${fileName} width`);
    assert.equal(info.height, size, `${fileName} height`);
  }

  // Verify icon.png has transparent outer padding, a white canvas tile, and gray graph strokes (not a black square).
  const masterPng = readPngInfo(join(iconsDir, 'icon.png'));
  assert.deepEqual(sampleRgbaPngPixel(masterPng, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(sampleRgbaPngPixel(masterPng, 256, 256), [255, 255, 255, 255]);
  // Top node top-edge stroke: 512-space (256, 92) -> 1024-space (512, 312.125) -> 512-space (256, 156)
  const topStrokePixel = sampleRgbaPngPixel(masterPng, 256, 156);
  assert.equal(topStrokePixel[3], 255);
  assert.ok(topStrokePixel[0] >= 65 && topStrokePixel[0] <= 85, `expected gray stroke (~#4a4a4a), got ${topStrokePixel}`);
  assert.equal(topStrokePixel[0], topStrokePixel[1]);
  assert.equal(topStrokePixel[1], topStrokePixel[2]);
  // Left node left-edge stroke: 512-space (62, 256) -> 1024-space (275.56, 512) -> 512-space (138, 256)
  const leftStrokePixel = sampleRgbaPngPixel(masterPng, 138, 256);
  assert.equal(leftStrokePixel[3], 255);
  assert.ok(leftStrokePixel[0] >= 65 && leftStrokePixel[0] <= 85, `expected gray stroke (~#4a4a4a), got ${leftStrokePixel}`);
  assert.equal(leftStrokePixel[0], leftStrokePixel[1]);
  assert.equal(leftStrokePixel[1], leftStrokePixel[2]);

  const icns = readFileSync(join(iconsDir, 'icon.icns'));
  assert.equal(icns.subarray(0, 4).toString('ascii'), 'icns');
  assert.ok(icns.length > 10_000, 'icon.icns should contain multi-resolution macOS icon entries');

  const ico = readFileSync(join(iconsDir, 'icon.ico'));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.ok(ico.readUInt16LE(4) >= 4, 'icon.ico should contain multiple Windows icon sizes');
});

test('Vite config keeps browser dev/build defaults intact and suppresses auto-open in desktop dev', async () => {
  const viteSource = readFileSync(join(root, 'vite.config.ts'), 'utf8');
  assert.match(viteSource, /GRAPHER_DESKTOP_DEV/);
  assert.match(viteSource, /TAURI_ENV_PLATFORM/);
  assert.match(viteSource, /\*\*\/src-tauri\/\*\*/);
  assert.match(viteSource, /open:\s*!isDesktopDev/);
  assert.match(viteSource, /"\/api":\s*\{/);
});

test('desktop staging resolves macOS arm64/x64 and Windows x64 targets with pinned Node SHA-256', () => {
  assert.equal(PINNED_NODE_VERSION, '22.19.0');
  for (const id of ['macos-arm64', 'macos-x64', 'windows-x64']) {
    const target = resolveDesktopTarget(id);
    assert.equal(target.id, id);
    assert.match(target.nodeSha256, /^[a-f0-9]{64}$/);
    assert.equal(resolveDesktopTarget(target.rustTriple), target);
  }
  assert.equal(resolveDesktopTarget(null, 'darwin', 'arm64'), DESKTOP_TARGETS['macos-arm64']);
  assert.equal(resolveDesktopTarget(null, 'darwin', 'x64'), DESKTOP_TARGETS['macos-x64']);
  assert.equal(resolveDesktopTarget(null, 'win32', 'x64'), DESKTOP_TARGETS['windows-x64']);
  // Verify exact Windows sidecar/Node resource names and bundle kind.
  assert.equal(DESKTOP_TARGETS['windows-x64'].backendBinary, 'grapher.exe');
  assert.equal(DESKTOP_TARGETS['windows-x64'].nodeRelPath, 'node/node.exe');
  assert.equal(DESKTOP_TARGETS['windows-x64'].bundleKind, 'nsis');
  assert.equal(DESKTOP_TARGETS['macos-arm64'].backendBinary, 'grapher');
  assert.equal(DESKTOP_TARGETS['macos-arm64'].nodeRelPath, 'node/bin/node');
  assert.equal(DESKTOP_TARGETS['macos-x64'].backendBinary, 'grapher');
  assert.equal(DESKTOP_TARGETS['macos-x64'].nodeRelPath, 'node/bin/node');
  assert.throws(() => resolveDesktopTarget('linux-riscv64'), /Unknown desktop target/);

  assert.equal(assertMinimumNodeVersion('v22.19.0'), '22.19.0');
  assert.equal(assertMinimumNodeVersion('24.0.1'), '24.0.1');
  assert.throws(() => assertMinimumNodeVersion('22.18.9'), /must be >= 22\.19\.0/);
  assert.throws(() => assertMinimumNodeVersion('20.19.0'), /must be >= 22\.19\.0/);
});

test('dereferenceSymlinksInPlace turns workspace directory and file symlinks into real bundleable copies', t => {
  const dir = tempDir(t);
  const pkgDir = join(dir, 'pi', 'packages', 'coding-agent');
  const modScope = join(dir, 'pi', 'node_modules', '@earendil-works');
  const binDir = join(dir, 'pi', 'node_modules', '.bin');
  mkdirSync(pkgDir, { recursive: true });
  mkdirSync(modScope, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  writeFileSync(join(pkgDir, 'package.json'), '{"name":"@earendil-works/pi-coding-agent"}\n');
  writeFileSync(join(pkgDir, 'cli.mjs'), 'console.log("ok");\n');

  symlinkSync(pkgDir, join(modScope, 'pi-coding-agent'), process.platform === 'win32' ? 'junction' : 'dir');
  if (process.platform !== 'win32') {
    symlinkSync(join(pkgDir, 'cli.mjs'), join(binDir, 'pi-cli'));
    symlinkSync(join(dir, 'nonexistent-target'), join(binDir, 'dangling-link'));
  }

  dereferenceSymlinksInPlace(dir);

  assert.deepEqual(findRemainingSymlinks(dir), []);
  const derefPkg = join(modScope, 'pi-coding-agent');
  assert.equal(lstatSync(derefPkg).isSymbolicLink(), false);
  assert.equal(lstatSync(derefPkg).isDirectory(), true);
  assert.equal(
    readFileSync(join(derefPkg, 'package.json'), 'utf8'),
    '{"name":"@earendil-works/pi-coding-agent"}\n',
  );
  if (process.platform !== 'win32') {
    assert.equal(lstatSync(join(binDir, 'pi-cli')).isSymbolicLink(), false);
    assert.equal(readFileSync(join(binDir, 'pi-cli'), 'utf8'), 'console.log("ok");\n');
    assert.throws(() => lstatSync(join(binDir, 'dangling-link')));
  }
});

test('ensureBundleableGitMetadata materializes a valid ref so bundlers preserve .git/refs/', t => {
  const piDir = join(tempDir(t), 'pi');
  const commit = 'b4afdddf44e059c67ccf5097e5317d913521b470';
  mkdirSync(join(piDir, '.git'), { recursive: true });
  writeFileSync(join(piDir, '.git', 'HEAD'), `${commit}\n`);

  ensureBundleableGitMetadata(piDir);
  assert.equal(
    readFileSync(join(piDir, '.git', 'refs', 'heads', 'grapher-baseline'), 'utf8'),
    `${commit}\n`,
  );
});

test('macOS nested signer identifies Mach-O binaries, excludes Java classes, and sorts deepest-first', t => {
  // Mach-O 64-bit little-endian (arm64/x86_64)
  assert.equal(isMachOBuffer(Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0])), true);
  // Mach-O universal fat binary with 2 architectures
  assert.equal(isMachOBuffer(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2])), true);
  // Java .class file (0xcafebabe + minor 0 + major 61)
  assert.equal(isMachOBuffer(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 61])), false);
  // Plain JS/shell script
  assert.equal(isMachOBuffer(Buffer.from('#!/bin/sh\necho hi\n')), false);

  const app = join(tempDir(t), 'Grapher.app');
  const machO64 = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]);
  const mainBin = join(app, 'Contents', 'MacOS', 'Grapher');
  const backendBin = join(app, 'Contents', 'Resources', 'runtime', 'grapher');
  const nodeBin = join(app, 'Contents', 'Resources', 'node', 'bin', 'node');
  const nativeAddon = join(
    app,
    'Contents',
    'Resources',
    'runtime',
    'pi',
    'node_modules',
    'fsevents',
    'fsevents.node',
  );
  const trackedPiPrebuild = join(
    app,
    'Contents',
    'Resources',
    'runtime',
    'pi',
    'packages',
    'tui',
    'native',
    'darwin',
    'prebuilds',
    'darwin-arm64',
    'darwin-platform.node',
  );
  const textFile = join(app, 'Contents', 'Resources', 'runtime', 'README.md');

  for (const file of [mainBin, backendBin, nodeBin, nativeAddon, trackedPiPrebuild]) {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, machO64);
  }
  writeFileSync(textFile, '# Grapher\n');

  const found = findMachOBinaries(app);
  assert.equal(found.length, 4);
  assert.equal(found.includes(trackedPiPrebuild), false);
  // Deepest nested native addon signs before node/backend, and main binary signs last among Mach-O files.
  assert.equal(found[0], nativeAddon);
  assert.equal(found.at(-1), mainBin);

  assert.match(entitlementsForBinary(nodeBin), /NodeEntitlements\.plist$/);
  assert.match(entitlementsForBinary(nativeAddon), /NodeEntitlements\.plist$/);
  assert.match(entitlementsForBinary(backendBin), /Entitlements\.plist$/);
  assert.doesNotMatch(entitlementsForBinary(backendBin), /NodeEntitlements\.plist$/);
});
