// Test composition lives here; package.json only exposes stable npm entry points.
// Keep explicit file lists: discovering every test at runtime would also launch
// platform-specific acceptance, browser builds and expensive stress probes.
const files = names => names.map(name => `scripts/${name}`);
const nodeTests = (...names) => ['--test', ...files(names)];
const sourceTests = (...names) => ['scripts/node-ts.mjs', '--test', ...files(names)];
const tsxTests = (...names) => ['--import', 'tsx', '--test', ...files(names)];
const cargo = (command, ...args) => ['scripts/cargo.mjs', command, '--manifest-path', 'backend/Cargo.toml', ...args];
const productionBuild = cargo('build', '--bin', 'grapher');
const headlessBuild = cargo('build', '--no-default-features', '--bin', 'grapher');
const verifyPi = ['scripts/pi-baseline.mjs', 'verify'];

// Each array is passed directly to the current Node executable, without a shell.
// A { suite } entry reuses another suite's steps without duplicating its list.
export const suites = {
  scripts: {
    description: 'Test inventory, setup/dev helpers, build isolation and release packaging (no backend build).',
    steps: [nodeTests('test-runner.test.mjs', 'ensure-deps.test.mjs', 'dev.test.mjs'),
      { suite: 'build-cache' }, { suite: 'release' }],
  },
  frontend: {
    description: 'Frontend state, graph projection and transcript logic; no browser or production build.',
    steps: [
      sourceTests(
        'display-preferences.test.ts', 'landing-draft.test.ts', 'graph-elements.test.ts',
        'file-changes.test.ts', 'planner-user-turns.test.ts', 'planner-graph-edits.test.ts',
        'conversation-branch.test.ts', 'conversation-scroll.test.ts', 'transcript-window.test.ts',
        'tool-output.test.ts', 'pi-tree-branch.test.ts', 'planner-branch.test.ts',
        'node-working.test.ts', 'pending-steers.test.ts', 'frontend-i18n.test.ts',
        'workbench-split-ratio.test.ts', 'workspace-conversations.test.ts',
        'workspace-path-display.test.ts', 'runtime-completions.test.ts',
        'request-timeout.test.ts', 'extension-settings.test.ts',
      ),
      tsxTests(
        'model-settings.test.ts', 'transcript-cache.test.ts', 'thinking-transcript.test.ts',
        'markdown-code-copy.test.ts', 'math-markdown.test.ts', 'markdown-safety.test.ts',
        'transcript-coalescing.test.ts', 'transcript-compaction.test.ts', 'transcript-settle.test.ts',
        'attachment-card.test.ts', 'frontend-performance.test.ts', 'execution-time-took.test.ts',
        'session-token-usage.test.ts',
      ),
    ],
  },
  ui: {
    description: 'Mocked-API browser flows; Chromium/GRAPHER_BROWSER_CHANNEL, no production build.',
    steps: [nodeTests(
      'background-settings-ui.test.mjs', 'workspace-ui.test.mjs', 'sidebar-copy-prompt-ui.test.mjs',
      'manual-node-ui.test.mjs', 'workspace-changes-ui.test.mjs', 'bootstrap-settings-ui.test.mjs',
      'frontend-audit.test.mjs', 'dialog-accessibility.test.mjs', 'conversation-history-ui.test.mjs',
      'steer-order-ui.test.mjs', 'composer-continuation-ui.test.mjs', 'composer-commands-ui.test.mjs',
      'planner-handoff-ui.test.mjs', 'graph-switching.test.mjs', 'graph-planning-fit.test.mjs',
      'responsive-layout.test.mjs', 'workbench-details-ui.test.mjs', 'frontend-performance-ui.test.mjs',
    )],
  },
  'ui-polish': {
    description: 'Opt-in bilingual home/settings viewport sweep; optional GRAPHER_UI_SCREENSHOTS output.',
    steps: [nodeTests('ui-polish.test.mjs')],
  },
  bundle: {
    description: 'Temporary production frontend build and deferred-loading browser checks.',
    steps: [nodeTests('frontend-bundle.test.mjs')],
  },
  backend: {
    description: 'Full Rust fixture suite (builds Rust test targets).',
    steps: [cargo('test', '--no-default-features', '--features', 'fixture')],
  },
  pi: {
    description: 'Pinned Pi verification, setup helpers, transport and SDK compatibility.',
    steps: [
      verifyPi,
      nodeTests('adopt-pi.test.mjs', 'pi-baseline.test.mjs', 'agent-dir.test.mjs',
        'model-visibility.test.mjs', 'ensure-deps.test.mjs', 'dev.test.mjs',
        'planning-trajectory.test.mjs', 'pi-process-contract.test.mjs'),
      sourceTests('execution-retry.test.ts', 'pi-compat.test.ts', 'global-extensions.test.ts',
        'continuation-context.test.ts'),
      tsxTests('continuity-boundary.test.ts'),
    ],
  },
  'native:scripts': {
    description: 'Native paths, storage, workspace tools and Planner rebinding; Git/Bash and pinned Pi.',
    steps: [nodeTests('workspace-paths.test.mjs', 'native-runtime-storage.test.mjs'),
      sourceTests('workspace-tools.test.ts', 'planner-workspace-runtime.test.ts')],
  },
  native: {
    description: 'Native script suite plus Rust native/runtime-storage/Linux-sandbox tests.',
    steps: [{ suite: 'native:scripts' },
      cargo('test', '--lib', 'native::tests'),
      cargo('test', '--lib', 'native_runtime_storage::tests'),
      cargo('test', '--lib', 'linux_sandbox::tests')],
  },
  prewarm: {
    description: 'Ignored Rust prewarm tests, headless backend build and HTTP/native acceptance.',
    steps: [
      cargo('test', '--no-default-features', '--lib', 'prewarm', '--', '--include-ignored', '--test-threads=1'),
      headlessBuild,
      nodeTests('prewarm-http.test.mjs', 'prepared-host.test.mjs', 'probe-prewarm.test.mjs',
        'shared-native-runtime.test.mjs'),
    ],
  },
  'planner-bash': {
    description: 'Cross-platform Planner Bash semantics with the real host shell.',
    steps: [sourceTests('planner-bash.test.ts')],
  },
  environment: {
    description: 'Native environment admission/lifecycle; builds Rust, needs Python/Git/Bash/platform boundary.',
    steps: [
      verifyPi,
      nodeTests('environment-launch.test.mjs', 'environment-native-fixtures.test.mjs'),
      cargo('test', '--no-default-features', '--features', 'fixture', '--lib', 'environment', '--', '--test-threads=1'),
      cargo('test', '--no-default-features', '--lib', 'process_control::tests::managed_drain', '--', '--nocapture'),
      cargo('test', '--no-default-features', '--lib', 'native_copy::tests', '--', '--test-threads=1', '--nocapture'),
      ['scripts/environment-build.mjs'],
      sourceTests('environment-native.test.ts'),
    ],
  },
  'environment-chain': {
    description: 'Graph-chain environment discovery with a local model; native environment prerequisites.',
    steps: [verifyPi, ['scripts/environment-build.mjs'], sourceTests('environment-chain.test.ts')],
  },
  merger: {
    description: 'Production backend build and native Git composition/publication acceptance.',
    steps: [productionBuild, sourceTests('merger-native.test.ts')],
  },
  bindings: {
    description: 'Production backend build, project bindings and execution routing.',
    steps: [productionBuild, ['scripts/check-project-binding.mjs'], sourceTests('execution-route.test.mjs')],
  },
  extensions: {
    description: 'Production backend build and Pi role/tool contracts.',
    steps: [productionBuild, ['scripts/node-ts.mjs', 'scripts/check-pi-extension.ts']],
  },
  hardening: {
    description: 'Production backend build and HTTP/filesystem hardening acceptance.',
    steps: [productionBuild, nodeTests('platform-hardening.test.mjs')],
  },
  'windows-native': {
    description: 'Production backend build and Windows-only native acceptance.',
    steps: [productionBuild, sourceTests('windows-native.test.ts')],
  },
  'macos-browser': {
    description: 'Headless backend build and macOS-only acceptance; needs a browser.',
    steps: [headlessBuild, nodeTests('macos-browser-acceptance.test.mjs')],
  },
  concurrent: {
    description: 'Fixture backend build and concurrent HTTP runs; /bin/sh, skipped on Windows.',
    steps: [cargo('build', '--no-default-features', '--features', 'fixture', '--bin', 'grapher'),
      ['scripts/concurrent-runs.test.mjs']],
  },
  'conversation-acceptance': {
    description: 'Opt-in large-log migration/stress; see docs/development/conversation-logs.md.',
    steps: [['--expose-gc', 'scripts/conversation-acceptance.mjs']],
  },
  'build-cache': {
    description: 'Temporary Cargo target ownership and safe cleanup; no Rust compilation.',
    steps: [nodeTests('temporary-target.test.mjs')],
  },
  release: {
    description: 'Release launcher/packaging contracts; no archive build.',
    steps: [nodeTests('release-launchers.test.mjs')],
  },
};

export function suiteSteps(name, catalog = suites, parents = []) {
  if (!Object.hasOwn(catalog, name)) throw new Error(`Unknown test suite: ${name}`);
  if (parents.includes(name)) throw new Error(`Test suite cycle: ${[...parents, name].join(' -> ')}`);
  return catalog[name].steps.flatMap(step => Array.isArray(step)
    ? [[...step]]
    : suiteSteps(step.suite, catalog, [...parents, name]));
}
