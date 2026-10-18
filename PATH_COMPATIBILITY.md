# Path compatibility remediation

Status tracker for the cross-platform Node Agent path work. Implementation and
tests remain authoritative; update this file when behavior or scope changes.

Legend: `[x]` done, `[~]` partial / explicitly guarded, `[ ]` not started.
Current status: every item is implemented except the explicitly marked
remote-command and cross-volume case-heuristic limitations.

## 1. Shared path identity

- [x] TypeScript `path-identity` helper (`samePath`, `pathKey`, case/NFD,
      `\\?\`, `/c/`, file URL, 8.3 fallback)
- [x] Use identity in `workspace-paths` / `workspace-tools`
- [x] Use identity in `prepared-host` / `launch-binding` / global extensions
- [x] Rust `path_identity` helper (`same_path`, `actual_path`, `path_key`)
- [x] Use identity in native validation / prewarm / runtime / session / env layout

## 2. macOS case-insensitive + Unicode normalization

- [x] Prepared-host bind uses file identity, not realpath spelling
- [x] Node session resume/fork uses actual cwd spelling (`F_GETPATH`)
- [x] Planner session rebind uses actual cwd spelling
- [x] Bash/file-tool source prefix matching handles case/NFD variants
- [~] Source and workspace on volumes with different case sensitivity use the
      workspace volume as a best-effort heuristic; the source is inaccessible
      inside the sandbox, so it cannot be probed. Same-volume APFS/NTFS is covered.
- [x] Runtime workspace ownership and environment layout comparisons use identity

## 3. Windows HOME / USERPROFILE / MSYS paths

- [x] Unify Rust `home_dir()` (USERPROFILE first, `~`, `/c/...`, `/cygdrive/...`)
- [x] Use for agent dir, global agent dir, skills
- [x] Normalize data/cache/workspace/runtime/agent path environment variables
- [x] JS agent-dir/global-agent/provider-auth paths accept `~\\` and MSYS spellings

## 4. Model-facing paths

- [x] Windows visible paths use `/` separators (`./src/app.ts`)
- [x] File tools accept `file://` and `/c/...`
- [x] Bash mapping translates known `file://` URLs without injecting quotes
- [x] Final assistant output and previous-environment hints are normalized
- [x] All known Planner workspace roots stay in the project namespace
- [x] Plain heredoc paths are not rewritten; remote URLs are not split

## 5. Windows filesystem semantics

- [x] Node IDs avoid reserved device names and case-only ref collisions
- [x] `.git` / `.grapher*` exclusions are case-insensitive on Win/macOS
- [x] Runtime workspace ownership comparisons use path identity
- [x] Source/host ref locks and snapshot/merge path checks use the same identity
- [x] Windows long-path preflight with an actionable cache-root error

## 6. Performance and shell hardening

- [x] Resolve `cygpath` through `GRAPHER_TRUSTED_GIT`; keep per-process memo
- [x] Batch all root spellings through one `cygpath -u -p` call per agent
- [x] Per-node TMP/TEMP/TMPDIR/XDG_RUNTIME_DIR; CDPATH/OLDPWD/GLOBIGNORE removed
- [x] Nested `bash.exe` detection; heredoc/URL false positives guarded
- [~] Common `ssh/scp/rsync host:/path` and URL forms are left untouched;
      a remote path quoted after a space (for example `ssh host 'cd /source'`)
      remains a finite-adaptation limitation.
- [x] Non-UTF-8 source/workspace paths fail early with a clear diagnostic

## Review pass

- [x] `file://` mapping has a path boundary (`source-other` is not mapped)
- [x] Heredoc ranges are recomputed after nested-script replacements
- [x] Bash scanning checks remote/URL context only on a real prefix match
- [x] Redundant per-project command scans were removed
- [x] File-tool roots are normalized before relative mapping
- [x] Relative scope comparison stays exact on macOS case-sensitive volumes
- [x] `cygpath` discovery avoids the extra `git --exec-path` when trusted
      candidates exist
- [x] Duplicate/mixed Windows separators and `/cygdrive/c/...` spellings are
      normalized for visible paths and command adaptation
- [x] Windows `host_path` compiles without converting `Cow<str>` directly to
      `PathBuf` (Windows-only compile failure reported by the handoff host)
- [x] Planner session rebind locates legacy/arbitrary JSONL filenames by header
      identity; Node session resume keeps the strict `_<id>.jsonl` contract
- [x] Non-macOS `repository_status` reports new ignored host metadata that
      forced snapshots would collect, using `git ls-files --others --ignored`
      instead of relying on platform-specific `status --ignored`. Tracked edits
      stay visible and internal `.grapher*`/scope/data paths stay filtered.
      Covered by a platform-neutral filter unit test.
- [x] Prepared-host binding accepts runtime-owned CDPATH/OLDPWD/GLOBIGNORE
      removals and TMP/TEMP/TMPDIR/XDG_RUNTIME_DIR values
- [x] Windows session rebind writes the launched spelling (`host_path(cwd)`),
      not an expanded canonical path; Unix keeps the resolved actual spelling
- [x] Unicode NFC/NFD test expectations are platform-specific: APFS treats them
      as one file; Linux/Windows keep distinct names
- [x] JS `actualPath()` mirrors Rust `actual_path()`: native realpath plus the
      deepest existing ancestor, used by `samePath`/`pathKey`/`mapPhysicalPath`
      for 8.3, junctions, symlinks, missing leaves and macOS case spelling
- [x] Command path words are resolved before project-prefix mapping, so `.`,
      `..`, 8.3 and junction spellings map to the normalized workspace path;
      paths that escape the project keep the external/relative tail
- [x] Workspace-external access audit is a local-only `NODE_OPTIONS --import`
      hook under gitignored `.grapher-path-audit/`; it is not tracked code and
      not a Pi extension, so ordinary Pi never loads it

## Windows host handoff

Run from the repository root with Node 22.19+, Git for Windows and the pinned
Pi setup already installed. Do not run the whole `npm test` suite first; use the
Windows-specific and path-specific checks below.

### Automated checks

- [x] `npm run check`
- [x] `node scripts/cargo.mjs check --manifest-path backend/Cargo.toml --no-default-features`
- [x] `node --test scripts/workspace-paths.test.mjs` (the Windows branch now runs)
- [x] `node scripts/node-ts.mjs --test scripts/workspace-tools.test.ts`
- [x] `npm run test:native`
- [x] `npm run test:windows-native`
- [x] `node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib path_identity`
- [x] `node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib session_branch`
- [x] `node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib native::tests`
- [x] `node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib runtime::tests`

Result (2026-10-18, base commit `f1bd65a`, Windows 10.0.26300 x64, Node
v24.16.0, Git for Windows 2.54.0): every check above passed. The first Windows
run exposed two regressions that are fixed in this working tree:

- `mapPhysicalPath()` was returning a `resolve()`-normalized path for every
  input, so external paths lost their caller spelling (`C:/...` became
  `C:\...`). Internal paths still normalize and map; external paths are
  returned unchanged again.
- Unquoted native `C:\...` command words were parsed as POSIX escapes by
  `shellWords`, so the word-level mapper missed them and the character scanner
  replaced only the root. Drive/UNC backslashes are now literal on Windows,
  including attached options such as `cc -IC:\...`.

The Windows branch of `workspace-paths.test.mjs` now also covers a workspace
name containing `;` (the one-shot `cygpath -u -p` batch must fall back to
per-value conversion instead of mis-splitting), and `path_identity` covers the
long-path preflight message.

### Manual acceptance matrix

- [x] Launch `npm run dev` from Git Bash where `HOME=/c/Users/...`; verify
      `PI_CODING_AGENT_DIR` resolves under `USERPROFILE`, models/auth load, and
      no directory appears under `C:\c\...`.
      Automated equivalent: temporary `USERPROFILE` plus Git Bash `HOME`;
      default, `~\...` and `/tmp/...` (MSYS) spellings all resolved under
      `USERPROFILE`, with no `C:\c\...` directory.
- [x] Use a project path containing spaces, Unicode and a case variant; run a
      Graph with Planner + node + Merger; verify `pwd`, `cat`, `read`, `write`,
      `edit` all stay in the workspace and publication writes the source once.
      Verified by rerunning `windows-native.test.ts` with `TEMP` set to
      `...\Grapher Path Case Test` (spaces, Unicode parent, mixed case);
      concurrent Planner runs, inheritance and publication all passed.
- [x] Exercise source spellings from Bash: native `C:\...`, forward `C:/...`,
      MSYS `/c/...`, Cygwin `/cygdrive/c/...`, extended `\\?\...`, doubled
      separators, and a file URL. Commands must map to the workspace; external
      paths must remain external.
      Covered by the Windows branch of `workspace-paths.test.mjs`.
- [x] Verify `visible` output uses `./...` on Windows and that tool results,
      final assistant text and environment hints contain no physical workspace
      path.
      Covered by `workspace-paths`, `workspace-tools`, `planner-bash` and
      global-extension hint tests.
- [x] Complete a node, send Continue/follow-up, and switch Planner workspace;
      verify Pi sessions resume without `Cannot resume node session` or a stale
      session-cwd mismatch.
      Automated equivalent: `prepared-host`, `planner_workspace_tests` (10),
      `runtime::tests` (138, including follow-up/revision) and
      `session_branch` (5) all pass.
- [x] Check `cygpath` behavior: a batch of roots should convert in one call;
      a path containing `;` must fall back safely rather than mis-splitting.
      Confirm a warm/cold node start does not stall on repeated `cygpath`.
      The semicolon fallback is now a Windows regression test; warm/cold starts
      are covered by the prewarm suite.
- [x] Set a cache/workspace parent near the Windows path limit and verify the
      preflight error tells the user to choose a shorter parent. Set a short
      parent and verify execution works.
      Unit coverage asserts the actionable
      `GRAPHER_CACHE_DIR/GRAPHER_WORKSPACE_PARENT` hint; a live near-limit
      launch was not repeated after the unit check.
- [x] Create graphs with nodes named `CON`, `NUL`, `COM1`, and with `Worker` vs
      `worker`; verify reserved names are hashed and case-only duplicates are
      rejected with a clear compiler diagnostic.
      Covered by `node_id_tests` (2 passed).
- [x] Create `.GIT`/`.GRAPHER` directories in a test project and verify they are
      excluded from size checks, Planner copies, snapshots and managed scopes.
      Covered by `path_identity` metadata-name tests, `workspace_tests` (5) and
      `status_filter_tests` (2).

### Failure triage

Record actual/expected values, Windows build, Git version, Node version and the
exact command. The highest-risk Windows-only areas are:

- batch `cygpath -u -p` output splitting/order (compare with per-value conversion);
- `visibleWindowsRoots` output for doubled/mixed separators;
- `path.win32.resolve` normalization of duplicate separators and 8.3 names;
- session header cwd versus the actual `process.cwd()` spelling;
- source and workspace on volumes with different case sensitivity.

Windows triage results (same host as above):

- batch `cygpath`: one `-u -p` call per agent; a `;` in a workspace name makes
  the count differ and correctly drops the batch cache so per-value conversion
  runs. Regression test passes.
- `visibleWindowsRoots`: doubled, mixed and JSON-escaped separators collapse
  into a single separator under the `./` root; all separator assertions pass.
- `path.win32.resolve`: internal doubled/8.3/extended spellings map to the
  workspace, while external paths keep the caller's spelling. Both assertions
  pass after the fix above.
- session cwd: `prepared-host`, `planner_workspace_tests`, `session_branch` and
  `runtime::tests` show no stale-cwd or resume failure.
- different-volume case sensitivity: not applicable on this single-volume (C:)
  host; same-volume NTFS case folding is covered.

Add the results, any follow-up issue and the tested commit SHA to this tracker
before declaring the Windows handoff complete.

## Verification log

Targeted checks run while implementing:

- `node --test scripts/workspace-paths.test.mjs` — pass (Windows case skipped on this host);
  includes case/NFD, URL, heredoc, remote-URL, attached-option and
  Windows visible-separator checks
- `node scripts/node-ts.mjs --test scripts/workspace-tools.test.ts` — pass
- `node scripts/node-ts.mjs --test scripts/planner-bash.test.ts` — pass
- `node --test scripts/environment-launch.test.mjs` — pass
- `node --test scripts/prepared-host.test.mjs` — pass
- `node scripts/node-ts.mjs --test scripts/global-extensions.test.ts` — pass
- `node --test scripts/agent-dir.test.mjs` — pass
- `cargo test --lib path_identity` / `session_branch` / `native::tests` /
  `runtime::tests` / `environment::tests` / `workspace_tests` /
  `workspace_files` / `compiler node_id_tests` — pass
- `node scripts/cargo.mjs check` and `npm run check` — pass
- `server::prompt_tests` — 62 passed (includes revision/session follow-up)
- `server::planner_review_tests` — 9 passed (includes auto/manual post-task review)
- `workspace::workspace_tests` — 8 passed (host metadata snapshot/status)
- `workspace::status_filter_tests` — 2 passed (macOS vs other-host filtering and real `git ls-files` collection)
- `scripts/prewarm-http.test.mjs` — auto-refill prepared-host binding pass
- `scripts/prepared-host.test.mjs` — three-role binding pass
- `workspace::workspace_tests` / `status_filter_tests` — rerun after switched
  ignored metadata collection via `ls-files`
- `server::planner_workspace_tests` — 10 passed after Windows launched-spelling
  session rebind
- Windows-only assertions (drive-letter case, `/c/...`, batch `cygpath`,
  extended paths) are covered by the existing Windows test and run in the
  Windows CI lane; they could not be executed on this macOS host.

## Windows implementation review (2026-10-18)

Reviewed the Windows handoff commit plus the follow-up path changes. The core
direction is sound: Windows launched-spelling session rebind, 8.3/junction
actual-path resolution, MSYS-root conversion, external-path preservation and
the `git ls-files` ignored-metadata collection are consistent with the macOS
and Linux behavior.

### Fixed during review

- [x] Windows `session_branch` fork test now asserts the platform policy
      independently: launched `host_path(new)` spelling (8.3 preserved) on
      Windows, resolved `actual_path(new)` spelling on Unix. This fixes the
      `RUNNER~1` vs `runneradmin` CI failure without making the assertion
      tautological.
- [x] Full backend library suites rerun on Windows:
      `node scripts/cargo.mjs test --manifest-path backend/Cargo.toml
      --no-default-features --lib` — 299 passed, 1 ignored; and the fixture suite
      `... --no-default-features --features fixture --lib` — 412 passed.
      The CI failure (`RUNNER~1` vs `runneradmin`) is fixed by asserting
      the platform-specific launched/actual spelling instead of forcing
      `actual_path()` on Windows.
- [x] File-tool input now uses registered Git Bash mount aliases
      (`msysHostInput`) before `resolveToCwd()`: `/tmp/...` in `read`/`write`/
      `edit` maps to the host TEMP/workspace/source path instead of `C:\\tmp`.
      Added a Windows integration test for both source and external `/tmp` paths.
- [x] `cygpath -u -p` batching now excludes values containing `;` entirely; a
      semicolon workspace path cannot rely on an output-count coincidence and
      always uses per-value conversion.
- [x] Added Windows assertions for the MSYS/`/tmp` spelling of a semicolon
      workspace and source, not only native spellings.

### Residual findings (checked)

- [x] The command scanner still conservatively leaves a token containing
      `.`/`..` unadapted when the word-level mapper did not handle it (glob or
      quoted substitution). Verified as a deliberate miss, not a false rewrite;
      it now emits a `[grapher-path]` diagnostic unless
      `GRAPHER_PATH_DIAGNOSTICS=0`. Covered by external-escape and dotted-glob
      tests.
- [x] `workspace-tools` external paths are normalized by `resolveToCwd()` before
      `mapPhysicalPath`; caller-spelling preservation applies to
      `workspace-paths.physical()` and command adaptation. Verified as
      intentional: file tools need a host path. Documented in the semantics
      section above.
- [x] Project-root actual paths are cached per execution, and resolved MSYS
      aliases are cached; command token mapping no longer realpaths every root
      for every word. Per-target `actualPath()` is intentionally not cached
      because file targets can be created, replaced, or linked between calls.
- [x] The local `.grapher-path-audit/` hook remains untracked and is not CI
      acceptance evidence; committed path behavior is covered by the repository
      tests and the full Windows suites below.

## Windows verification log (2026-10-18)

Host: Windows 10.0.26300 x64, Node v24.16.0, npm 12.1.0, Git for Windows
2.54.0, tested base commit `f1bd65a` plus the working-tree fixes above.

- `npm run check` — pass
- `node scripts/cargo.mjs check --manifest-path backend/Cargo.toml --no-default-features` — pass
- `node --test scripts/workspace-paths.test.mjs` — 2 pass, 1 platform skip;
  Windows branch covers native/forward/MSYS/Cygwin/extended/doubled/URL
  spellings, external preservation and the `;` cygpath fallback
- `node scripts/node-ts.mjs --test scripts/workspace-tools.test.ts` — pass;
  includes registered `/tmp` file-tool conversion
- `npm run test:native` — pass end to end (workspace paths, native runtime
  storage, workspace tools, `native::tests` 15, `native_runtime_storage::tests`
  11, `linux_sandbox::tests` 0, prewarm 18 + prepared-host/shared-runtime)
- `npm run test:windows-native` — pass; full Planner/Graph concurrency,
  inheritance, publication, cancellation and crash recovery
- `windows-native.test.ts` with `TEMP=...\Grapher Path Case Test` — pass
- `path_identity` — 3 pass (includes the long-path preflight assertion)
- `session_branch` — 5 pass
- `native::tests` — 15 pass
- `runtime::tests` — 138 pass
- `server::planner_workspace_tests` — 10 pass
- `node_id_tests` — 2 pass
- `workspace::workspace_tests` — 5 pass
- `workspace::status_filter_tests` — 2 pass
- `scripts/agent-dir.test.mjs` — 2 pass
- HOME/MSYS simulation with a temporary `USERPROFILE` and Git Bash `HOME` —
  default, `~\...` and MSYS spellings resolved under `USERPROFILE`; no
  `C:\c\...` path was created

Transient host issue: Cargo build artifacts (`backend/target/debug/.fingerprint`
and `backend/target/debug/grapher.exe`) disappeared between separate commands a
few times (Windows `os error 3` / `spawnSync ENOENT`). A rebuild made the same
commands pass, so this is recorded as host cleanup/scanning noise, not a path
regression. No full `npm test` suite was run.

## Follow-up hardening (2026-10-18)

After the Windows handoff, the following robustness-only changes were made. No
sandbox was added, and workspace-external writes remain allowed by design (for
example ML datasets outside the checkout).

### Actual host spelling parity

- `engine/path-identity.mjs` now exposes `actualPath()`: `realpathSync.native()`
  plus the deepest existing ancestor and missing suffix. It mirrors Rust
  `actual_path()` and is used by `samePath`, `pathKey` and `mapPhysicalPath`.
- The fallback covers symlinked requested/workspace spellings and missing leaves
  on every host; Windows additionally probes source roots for 8.3/junction
  aliases. Non-Windows source roots are not probed because they may be
  inaccessible inside the execution sandbox.
- `pathWithin()` provides a single case/NFD-aware containment check for
  workspace/source classification and future policy decisions.

### Command normalization

- `command()` resolves literal absolute/relative path words before matching a
  project root. `/source/../source/file` now maps to `workspace/file` instead of
  `workspace/../source/file`; `/source/./file`, 8.3 and junction spellings map
  the same way. A path that escapes every project root is left unchanged as an
  external path instead of being rewritten relative to the workspace. The
  generic scanner skips tokens containing `.`/`..`; literal words are handled by
  the word mapper first.
- Known MSYS mounts are converted back through the cached `cygpath` roots
  before canonical mapping, so `/tmp/.../source` maps correctly while a real
  native `C:\\tmp\\...` path is not mistaken for the Git Bash `/tmp` mount.
- The change is best-effort for shell constructs the scanner does not evaluate
  (`$VAR`, `eval`, sourced scripts, `cmd.exe`/PowerShell); ordinary literal
  paths are covered.

### External path spelling semantics

- `physical()` and command adaptation preserve the caller's external spelling
  where the access is not rewritten.
- `read`/`write`/`edit` intentionally normalize to a host path after
  `msysHostInput()`/`toHostInput()`/`resolveToCwd()`; file tools need a real
  filesystem spelling, so this difference is deliberate, not an inconsistency.

### Workspace-external access audit (local-only, not in this repository)

- The implementation is intentionally **not tracked and not a Pi extension**.
  It lives in `.grapher-path-audit/` (gitignored) together with a local launcher.
  Ordinary Pi, CI and release installs never load it.
- `start-audited.mjs` starts Grapher with `NODE_OPTIONS=--import=<hook>`; the
  same flag may be placed in the local gitignored `.env` if plain `npm run dev`
  should load it automatically. The hook installs even in prewarmed agent
  processes and builds its workspace context lazily after binding sets
  `GRAPHER_MODE`/workspace variables. It patches Node `fs`/`fs.promises` file
  tool calls and records external `read`/`write`/`open`/stream operations. It
  also inspects `child_process` command text for literal external paths and
  `../...` references.
- Storage order: `GRAPHER_PATH_AUDIT_DIR`, else
  `GRAPHER_DATA_DIR/path-audit`, else `~/.grapher/path-audit`. Files are daily
  JSONL, mode `0600`, capped at 4 MiB per day.
- Records include timestamp, pid, role/node/run/execution, operation,
  requested/resolved actual spelling, workspace, source, `exists`, `overwrites`,
  `writeHint` (command references only), and caller context. The actual
  realpath is recorded too, so a workspace symlink/junction that points outside
  is reported with its external target.
- `GRAPHER_PATH_AUDIT=0` disables it. The hook swallows its own errors and never
  blocks, rewrites, delays or retries an access. Records describe the attempt,
  not whether it later succeeded.
- Limitations: native Bash/Python file I/O is not traced; command text is
  best-effort and may miss `$VAR`, `eval`, sourced scripts, quoted-after-space
  remote forms, or `cmd.exe`/PowerShell. The hook logs path references, not file
  contents.
- `.grapher-path-audit/` is gitignored, and all `.grapher*` paths are excluded
  from status/snapshots/publication by the backend metadata filter. Remove the
  folder (and its local launcher) to remove the instrumentation entirely.

### Follow-up checks

- `node --test scripts/workspace-paths.test.mjs` — pass; includes junction
  identity, `actualPath` missing-leaf, `..` command normalization, nested
  aliases, external-escape preservation and native-vs-MSYS `/tmp` non-collision
- `node scripts/node-ts.mjs --test scripts/workspace-tools.test.ts` — pass;
  includes `/tmp` file-tool conversion
- `node scripts/node-ts.mjs --test scripts/planner-bash.test.ts` — pass
- `node --test scripts/environment-launch.test.mjs scripts/prepared-host.test.mjs`
  — pass
- `node scripts/node-ts.mjs --test scripts/global-extensions.test.ts` — 21 pass
- `node scripts/cargo.mjs test --manifest-path backend/Cargo.toml
  --no-default-features --features fixture --lib path_identity` — 3 pass
- `npm run test:native` — pass
- `npm run test:windows-native` — pass after the follow-up changes
- `npm run check` — pass
- local audit hook smoke test — loaded via `NODE_OPTIONS --import`, external
  Node reads/writes, a child-process command reference, and a Windows junction
  escape produced JSONL; not part of the repository test suite
