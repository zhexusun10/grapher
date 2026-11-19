#!/usr/bin/env node
// Reproducibly generates the Tauri desktop app icons under `src-tauri/icons/`
// from the web mark source (`assets/icon-dots.svg`), placing the gray mark
// on a clean white macOS/desktop rounded-square canvas.
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const WEB_ICON_SOURCE = join(root, 'assets', 'icon-dots.svg');
export const TAURI_ICONS_DIR = join(root, 'src-tauri', 'icons');

export const REQUIRED_DESKTOP_ICONS = Object.freeze([
  'icon.png',
  '32x32.png',
  '128x128.png',
  '128x128@2x.png',
  'icon.icns',
  'icon.ico',
]);

/**
 * Extract the vector shapes and light-theme color from `assets/icon-dots.svg`
 * and compose a 1024x1024 desktop app icon SVG with a white rounded-square canvas
 * and balanced padding (matching Apple HIG icon grid proportions without any dark
 * outer tile). Supports both stroke-based graph marks and fill-based dot marks
 * while resolving `@media (prefers-color-scheme: light)` explicitly for resvg.
 */
export function buildDesktopIconSvg(webSvgSource) {
  const shapes = webSvgSource.match(
    /<(?:path|rect|circle|ellipse|line|polygon|polyline)\b[^>]*\/>/gu,
  );
  if (!shapes || shapes.length === 0) {
    throw new Error('Could not find vector shape elements in assets/icon-dots.svg');
  }

  const lightStrokeMatch =
    /@media\s*\(\s*prefers-color-scheme:\s*light\s*\)\s*\{[^}]*stroke:\s*(#[0-9a-fA-F]{3,8})/u.exec(
      webSvgSource,
    );
  const lightFillMatch =
    /@media\s*\(\s*prefers-color-scheme:\s*light\s*\)\s*\{[^}]*fill:\s*(#[0-9a-fA-F]{3,8})/u.exec(
      webSvgSource,
    );
  const isStrokeMark = Boolean(lightStrokeMatch) || /\bfill:\s*none\b/u.test(webSvgSource);
  const markColor = (lightStrokeMatch?.[1] ?? lightFillMatch?.[1] ?? '#4a4a4a').toUpperCase();

  let groupAttrs;
  if (isStrokeMark) {
    const strokeWidth = /\bstroke-width:\s*([0-9.]+)/u.exec(webSvgSource)?.[1] ?? '22';
    const strokeLinecap = /\bstroke-linecap:\s*([a-z]+)/u.exec(webSvgSource)?.[1] ?? 'round';
    const strokeLinejoin = /\bstroke-linejoin:\s*([a-z]+)/u.exec(webSvgSource)?.[1] ?? 'round';
    groupAttrs = `fill="none" stroke="${markColor}" stroke-width="${strokeWidth}" stroke-linecap="${strokeLinecap}" stroke-linejoin="${strokeLinejoin}"`;
  } else {
    groupAttrs = `fill="${markColor}"`;
  }

  // 1024x1024 canvas:
  // - White rounded-square tile: 824x824 outer bounds (x=100..924, y=100..924),
  //   rendered as an 820x820 rect with a subtle 4px #E2E8F0 stroke (Grapher's
  //   --border-default) so the white tile stays crisp on light Finder/Dock surfaces.
  // - 512x512 web mark scaled by 1.21875 (624x624 box centered at 512,512),
  //   leaving clean, balanced white padding on every side.
  const indentedShapes = shapes
    .map(shape => `    ${shape.replace(/\s+class="[^"]*"/gu, '')}`)
    .join('\n');
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">',
    '  <title>Grapher</title>',
    '  <rect x="102" y="102" width="820" height="820" rx="185" ry="185" fill="#FFFFFF" stroke="#E2E8F0" stroke-width="4"/>',
    `  <g transform="translate(200 200) scale(1.21875)" ${groupAttrs}>`,
    indentedShapes,
    '  </g>',
    '</svg>',
    '',
  ].join('\n');
}

function resolveTauriCliEntry(installationRoot = root) {
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
  if (existsSync(binEntry)) {
    return { command: binEntry, prefixArgs: [] };
  }
  throw new Error('Could not locate @tauri-apps/cli. Run `npm ci` before regenerating icons.');
}

export function generateDesktopIcons({
  sourceSvgPath = WEB_ICON_SOURCE,
  outputDir = TAURI_ICONS_DIR,
  installationRoot = root,
} = {}) {
  const webSvgSource = readFileSync(sourceSvgPath, 'utf8');
  const desktopSvg = buildDesktopIconSvg(webSvgSource);
  const stagingDir = mkdtempSync(join(tmpdir(), 'grapher-desktop-icons-'));

  try {
    const svgPath = join(stagingDir, 'grapher-desktop-icon.svg');
    const generatedDir = join(stagingDir, 'generated');
    mkdirSync(generatedDir, { recursive: true });
    writeFileSync(svgPath, desktopSvg, 'utf8');

    const { command, prefixArgs } = resolveTauriCliEntry(installationRoot);
    const result = spawnSync(
      command,
      [...prefixArgs, 'icon', svgPath, '-o', generatedDir],
      { cwd: installationRoot, encoding: 'utf8', shell: false },
    );

    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `tauri icon failed (exit ${result.status}):\n${result.stderr || result.stdout}`,
      );
    }

    mkdirSync(outputDir, { recursive: true });
    for (const fileName of REQUIRED_DESKTOP_ICONS) {
      const from = join(generatedDir, fileName);
      if (!existsSync(from)) {
        throw new Error(`Expected Tauri icon output was not generated: ${fileName}`);
      }
      copyFileSync(from, join(outputDir, fileName));
    }

    return {
      outputDir,
      files: [...REQUIRED_DESKTOP_ICONS],
    };
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

function isDirectCliRun() {
  if (!process.argv[1]) return false;
  return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isDirectCliRun()) {
  const result = generateDesktopIcons();
  console.log(
    `[desktop:icons] Regenerated ${result.files.length} desktop icon assets in ${result.outputDir}: ${result.files.join(', ')}`,
  );
}
