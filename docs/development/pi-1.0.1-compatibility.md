# Pi 1.0.1 compatibility report

## Baseline and environment

- Checked on 2026-10-04: Windows x64, Node.js 24.16.0, npm 12.1.0, Cargo 1.98.1, Git for Windows Bash, fd 10.5.0, ripgrep 15.2.0.
- Upgraded the unmodified `pi/` submodule from `v1.0.0` (`a13d35a742c6ef8462812a28fbe1d8c8b7431c32`) to official `v1.0.1` (`a7229ddc21810d6245105978033b7df645ecc2f7`).
- Updated [pi-lock.json](../../engine/pi-lock.json) and the upstream-hydrated, checksummed [model catalog](../../engine/model-data/). No upstream source or dependency lockfile was patched.
- Preserved existing parent-repository changes. This report describes the tested working tree, not a clean published Grapher release.
- Used an isolated `CARGO_TARGET_DIR` because the existing backend process holds `backend/target/debug/grapher.exe` open. The running service was not stopped or restarted.

## Compatibility adaptations

1. **MCP project overrides:** Pi 1.0.1 supports project entries that override only `enabled`, `exposure`, and `toolExposure` of global servers. Grapher previously loaded external global and dedicated/project configs separately, so project overrides of external globals had no base to inherit. [mcp-config.ts](../../engine/mcp-config.ts) now merges global and dedicated definitions first, then applies trusted project entries using Pi's validator. Tests cover precedence, preserved credentials/source provenance, trust restrictions, invalid patches, namespace collisions, and parity with the upstream single-directory loader.
2. **Bash test contract:** Nonzero commands return `isError: true` with structured exit status in Pi 1.0; timeout and cancellation still throw. Updated smoke assertions rather than changing execution behavior.
3. **Isolated integration builds:** Extension, project-binding, and Windows native tests now honor `CARGO_TARGET_DIR`, matching the existing Merger harness.
4. **Windows planning history aliases:** `list_plannings` and `get_planning_snapshot` now compare existing repository directories after canonicalization and recognize Windows drive/device and UNC lexical aliases for archived paths. Missing or unresolvable paths remain fail-closed. Regression tests cover ordinary paths, `\\?\\` paths, case/separator aliases, Unicode names, UNC share boundaries, deleted directories, unrelated directories, and unattributed history.
5. **Reviewed Pi dependency profile:** `pi:setup` installs the exact, audited profile in [engine/pi-dependencies](../../engine/pi-dependencies/) instead of installing Pi's optional example workspaces. The profile contains the core Pi runtime/build graph and excludes the Gondolin example and the `shx`/`shelljs`/`fast-glob`/`micromatch`/`braces` build chain. [build-pi.mjs](../../scripts/build-pi.mjs) reproduces the required offline build with Node filesystem operations. Runtime launchers verify the profile marker, lock versions, package graph, and workspace bindings before starting Pi.

## Results

| Check | Result |
| --- | --- |
| `npm run pi:setup` | Passed; profile installation audited with 0 vulnerabilities and all Pi 1.0.1 core artifacts rebuilt |
| `npm run pi:verify`, `npm run pi:build` | Passed; upstream baseline, offline catalog validation, profile verification and all required workspace builds |
| `npm run pi -- --version` | Reports `1.0.1` |
| `npm run test:pi` | Passed: 25 Pi CLI/SDK, provider/auth, extension, prompt, MCP and adapter tests |
| `npm run pi:upgrade-check` | Passed; Pi baseline/build, contracts, TypeScript, full Rust fixtures, extension tools, native launchers and project bindings |
| `npm run check` | Passed; TypeScript checks |
| `npm run build` | Passed; Vite warns about a minified chunk over 500 kB in the normal production build |
| `npm run check:docs` and documentation checker tests | Passed; 32 Markdown files and 197 local links/anchors checked |
| `npm test` | Passed; full Rust fixture suite, with the existing synthetic performance test intentionally ignored |
| Targeted repository-binding Rust tests | Passed: 4 alias/Windows path tests plus the legacy fail-closed filtering test |
| `npm run test:windows-native` | Passed: 2 tests, including native Planner Bash, concurrent Graph execution, inheritance/publication, cancellation and crash recovery |
| `npm run test:merger` | Passed: source-native Planner writes/revisions, failed-revision persistence, retained dependency composition, node/source conflict repair, publication, and ordinary/extended Windows repository bindings |
| `npm audit --prefix engine/pi-dependencies --audit-level=high` | Passed with 0 info, low, moderate, high, or critical vulnerabilities |

The official upstream Pi lockfile still produces seven high-severity entries when audited directly with `npm audit --prefix pi`: five entries are the unused development `shx` chain and two are the optional Gondolin example's `node-forge` chain. Grapher's default setup no longer installs that graph, and the production launcher refuses to run an unreviewed Pi installation. The official Pi source and its checksum-verified upstream lockfile remain unchanged for baseline provenance.

## Remaining limits

- No paid provider calls or interactive OAuth sign-ins were performed. The provider/auth contract tests use isolated local transports.
- Linux bubblewrap and macOS Seatbelt were not exercised on this Windows host. The platform workflow covers those host-specific boundaries, but a configured workflow is not evidence that its job passed.
- The documented minimum Node.js 22.19 was not separately exercised on this Node.js 24 host.
- Saved provider/model settings are not automatically rewritten. The refreshed catalog uses dashed Cloudflare AI Gateway Claude IDs and Together's `deepseek-ai/DeepSeek-V4-Pro-0813`; NVIDIA's default now points to Nemotron 3 Ultra instead of the retired Super model. Review any saved selection using removed or renamed IDs in Settings.
- Already running or prewarmed agents and prepared native-runtime copies retain their loaded engine and adapter code; upgrading files is not a hot update. Restart the backend after reviewing the upgrade.

## Reproduction

With the pinned submodule checked out, use an isolated build directory if a backend is running. For PowerShell:

```powershell
$env:CARGO_TARGET_DIR = Join-Path $PWD '.grapher/pi-1.0.1-target'
$env:PI_OFFLINE = '1'
npm run pi:setup
npm run pi:verify
npm run pi:build
npm run pi -- --version
npm run test:pi
npm run test:windows-native
npm run test:merger
npm audit --prefix engine/pi-dependencies --audit-level=high
```

Run the frontend, Rust fixture, documentation, and platform-specific checks listed above separately where needed. Search binaries must already be available for offline extension tests. See [Pi integration](pi-integration.md) and [Testing](testing.md) for setup and acceptance boundaries.
