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

## Windows host handoff (next)

Run from the repository root with Node 22.19+, Git for Windows and the pinned
Pi setup already installed. Do not run the whole `npm test` suite first; use the
Windows-specific and path-specific checks below.

### Automated checks

- [ ] `npm run check`
- [ ] `node scripts/cargo.mjs check --manifest-path backend/Cargo.toml --no-default-features`
- [ ] `node --test scripts/workspace-paths.test.mjs` (the Windows branch now runs)
- [ ] `node scripts/node-ts.mjs --test scripts/workspace-tools.test.ts`
- [ ] `npm run test:native`
- [ ] `npm run test:windows-native`
- [ ] `node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib path_identity`
- [ ] `node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib session_branch`
- [ ] `node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib native::tests`
- [ ] `node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib runtime::tests`

### Manual acceptance matrix

- [ ] Launch `npm run dev` from Git Bash where `HOME=/c/Users/...`; verify
      `PI_CODING_AGENT_DIR` resolves under `USERPROFILE`, models/auth load, and
      no directory appears under `C:\c\...`.
- [ ] Use a project path containing spaces, Unicode and a case variant; run a
      Graph with Planner + node + Merger; verify `pwd`, `cat`, `read`, `write`,
      `edit` all stay in the workspace and publication writes the source once.
- [ ] Exercise source spellings from Bash: native `C:\...`, forward `C:/...`,
      MSYS `/c/...`, Cygwin `/cygdrive/c/...`, extended `\\?\...`, doubled
      separators, and a file URL. Commands must map to the workspace; external
      paths must remain external.
- [ ] Verify `visible` output uses `./...` on Windows and that tool results,
      final assistant text and environment hints contain no physical workspace
      path.
- [ ] Complete a node, send Continue/follow-up, and switch Planner workspace;
      verify Pi sessions resume without `Cannot resume node session` or a stale
      session-cwd mismatch.
- [ ] Check `cygpath` behavior: a batch of roots should convert in one call;
      a path containing `;` must fall back safely rather than mis-splitting.
      Confirm a warm/cold node start does not stall on repeated `cygpath`.
- [ ] Set a cache/workspace parent near the Windows path limit and verify the
      preflight error tells the user to choose a shorter parent. Set a short
      parent and verify execution works.
- [ ] Create graphs with nodes named `CON`, `NUL`, `COM1`, and with `Worker` vs
      `worker`; verify reserved names are hashed and case-only duplicates are
      rejected with a clear compiler diagnostic.
- [ ] Create `.GIT`/`.GRAPHER` directories in a test project and verify they are
      excluded from size checks, Planner copies, snapshots and managed scopes.

### Failure triage

Record actual/expected values, Windows build, Git version, Node version and the
exact command. The highest-risk Windows-only areas are:

- batch `cygpath -u -p` output splitting/order (compare with per-value conversion);
- `visibleWindowsRoots` output for doubled/mixed separators;
- `path.win32.resolve` normalization of duplicate separators and 8.3 names;
- session header cwd versus the actual `process.cwd()` spelling;
- source and workspace on volumes with different case sensitivity.

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
