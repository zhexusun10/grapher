# Tauri desktop architecture & implementation record

> **Status:** Implemented (Tauri v2 desktop shell, sidecar lifecycle, bundled runtime staging, launch at login, in-app updater, and three-layer signing/release automation). Local macOS `arm64` `.dmg` packaging and automated desktop/signing suites are verified; Windows native runtime smoke testing awaits a native Windows host or `windows-latest` CI run.
> **Scope:** Desktop shell architecture, sidecar lifecycle, bundled Node + Pi runtime, Git discovery/preflight, data-directory migration, IPC/CORS boundaries, dev-mode compatibility, and updater signing behavior.

## 1. Repository analysis findings

Inspection of the current repository confirms the following baseline:

1. **Frontend (`src/`, `vite.config.ts`, `package.json`):**
   - Vite 7 + React 19 + TypeScript SPA built into `dist/`.
   - All backend communication uses relative `/api/...` paths over loopback HTTP and SSE:
     - JSON RPC `POST /api/<command>`, streaming `POST /api/plan_goal_stream`, and `POST /api/get_workspace_image` in `src/services/runtime.ts`.
     - `POST /api/provider_auth` in `src/services/providerAuth.ts`.
     - `POST /api/pi_extensions` in `src/services/piExtensions.ts`.
     - `EventSource("/api/events")` in `src/services/runtimeEvents.ts`.
   - In development (`npm run dev` / `scripts/dev.mjs`), Vite listens on `127.0.0.1:1420` and proxies `/api` to `http://127.0.0.1:${GRAPHER_PORT || 1421}`.

2. **Long-lived backend (`backend/`):**
   - Already a standalone, mature Rust crate/binary (`backend/Cargo.toml`, `backend/src/main.rs`, `backend/src/server.rs`) serving `tiny_http` on `127.0.0.1` using `GRAPHER_PORT` (default `1421`).
   - Owns SQLite event/log persistence (`rusqlite`), Git/worktree management (`git2` + host `git`), Graph compilation/scheduling/merging/publication, OS execution sandboxes (macOS Seatbelt in `backend/src/sandbox.rs`, Linux `bubblewrap` in `backend/src/linux_sandbox.rs`), process-tree supervision (`backend/src/process_control.rs`), static `dist/` serving, and strict loopback `Host`/`Origin` validation (`backend/src/server.rs`).
   - Currently passes the parsed `GRAPHER_PORT` integer into `handle_http_request` and validates `Origin` via `http://`/`https://` allowlist entries (`origin_matches_allowlist`) plus a `Sec-Fetch-Site: cross-site` rejection on `GET /api/events`.

3. **Agent / Pi engine (`engine/`, `pi/`, `scripts/`):**
   - TypeScript/JavaScript runtime pinned to the `pi` Git submodule (`.gitmodules`, `engine/pi-lock.json`, `scripts/pi-baseline.mjs`).
   - Launched directly by Rust through Node (`engine/entrypoint.mjs`, `engine/provider-host.ts`, `engine/extensions-host.ts`, `scripts/prepare-native-runtime.mjs`) across `backend/src/native.rs`, `backend/src/provider_auth.rs`, `backend/src/pi_extensions.rs`, and `backend/src/engine/`.
   - **There is no separate TypeScript HTTP backend to migrate.**

4. **Existing release packaging (`.github/workflows/release.yml`, `scripts/package-release.mjs`):**
   - Builds a relocatable archive (`tar.gz` on macOS/Linux, `zip` on Windows) containing the compiled `grapher` executable, built `dist/`, the verified Pi/engine runtime prepared by `scripts/prepare-native-runtime.mjs` (`pi/` with standalone `.git` metadata, `engine/`, `scripts/`, bundled extension packages in `node_modules/`, `package.json`, `package-lock.json`), and shell/batch launchers (`start.sh`, `start.bat`) that require Node.js 22.19+ and Git on the user's `PATH`.
   - No `src-tauri/` project or desktop installer packaging exists yet.

5. **Persistence and storage layout:**
   - **Server runtime data** (`events.sqlite`, `runtime.lock`, `config.json`, `sessions/`, `planner-sessions/`, `planning/`, `mergers/`, `environments/`, `shadow_repos/`, `attachment-inputs/`, `file-changes/`) defaults to `<installation-root>/.grapher` (`backend/src/workspace.rs::data_root()`), overridable with `GRAPHER_DATA_DIR`. `backend/src/startup.rs` enforces exclusive writer locks (`backend/src/runtime_lock.rs`) and non-destructive format-version isolation (`format-1/`).
   - **Disposable workspace/engine caches** default to OS cache locations (`~/Library/Caches/Grapher`, `%LOCALAPPDATA%\Grapher`, `${XDG_CACHE_HOME:-~/.cache}/grapher`) via `default_cache_root()` in `backend/src/workspace.rs`.
   - **Pi provider credentials/config** default to `~/.grapher/pi-agent` (`backend/src/native.rs::agent_dir()`, overridable via `PI_CODING_AGENT_DIR`).
   - **Frontend UI preferences, workspace lists, and hints** live in browser/WebView `localStorage` (`src/services/appStorage.ts`, `src/services/displayPreferences.ts`, `src/services/landingDraft.ts`, `src/services/providerAuth.ts`, `src/hooks/useWorkbenchResizer.ts`, `src/i18n/index.ts`), with run-scoped keys namespaced by `grapher_data_path`.

---

## 2. Confirmed desktop architecture decisions

### 2.1 Retain `backend/` as an owned Tauri sidecar

- Add a thin Tauri v2 desktop shell under `src-tauri/` instead of duplicating or migrating `backend/` into `src-tauri/`.
- Build `backend/`'s `grapher` binary and package it as a Tauri-owned sidecar binary (`externalBin` / target-triple naming).
- Keep all business logic, runtime authority, SQLite storage, sandboxing, and Pi orchestration in `backend/`.
- `src-tauri/` owns only desktop concerns:
  - Resolving bundled resources (`engine/`, `pi/`, `scripts/`, private Node binary).
  - Resolving `GRAPHER_DATA_DIR` (`app_data_dir()/data`) and running the guarded first-launch legacy data copy.
  - Running Git discovery and environment preflight checks.
  - Spawning, monitoring, and cleanly shutting down the `grapher` sidecar.
  - Exposing backend connection info (ephemeral port, base URL, preflight/startup status) to the WebView via Tauri IPC.
  - Native desktop integration (window lifecycle, app icons, installers, and optional updater).

### 2.2 Bundle the pinned TS/Pi runtime and a private Node.js runtime

End-user machines must **not** be required to have Node.js or `npm` installed.

- **Bundled Pi/engine resources:** Reuse the verified runtime layout assembled by `scripts/prepare-native-runtime.mjs` (`engine/`, `pi/` including its standalone `.git` metadata required by `pi-baseline.mjs`, `scripts/`, bundled extension `node_modules/`, `package.json`, `package-lock.json`) and ship it inside Tauri's bundled resources directory.
- **Explicit resource root override:** Extend `backend/src/native.rs::installation_root()` to honor an explicit environment override (e.g., `GRAPHER_INSTALLATION_ROOT`) set by `src-tauri` to the bundled runtime resource directory. In macOS `.app` bundles (`Contents/MacOS/` vs `Contents/Resources/`) and Linux packages, the sidecar executable and its resource directory are not siblings; falling back to the existing `current_exe().parent()` + source-checkout logic preserves archive and dev launches.
- **Private Node runtime:** Bundle a platform/architecture-matched Node.js 22.19+ binary (exact pinned LTS version matching CI) inside the Tauri app bundle and pass its absolute path to the sidecar (e.g., `GRAPHER_NODE_PATH` / `GRAPHER_TRUSTED_NODE`).
- **Route all backend Node invocations through `trusted_node()`:**
  - Update `backend/src/native.rs::trusted_node()` to resolve the explicitly configured bundled Node executable first (validating it is an existing file and canonicalizing through `host_path()`), falling back to `PATH` lookup when unset (preserving `npm run dev` and standalone archives).
  - Replace remaining direct `Command::new("node")` calls in production backend code (`backend/src/native.rs` `RuntimeKeySession` and `run_runtime_preparation`, `backend/src/provider_auth.rs`, `backend/src/pi_extensions.rs`) with `crate::native::trusted_node()?`.
- **Sandbox compatibility:** Keep the bundled Node binary and bundled Pi/engine resources inside read-only app resource paths that macOS Seatbelt (`backend/src/sandbox.rs`) and Linux `bubblewrap` (`backend/src/linux_sandbox.rs`) permit reading/executing while denying writes.

### 2.3 Explicit Git discovery and preflight

Engine operations require a working host `git` executable: `scripts/pi-baseline.mjs` verifies the pinned Pi checkout, `scripts/prepare-native-runtime.mjs` clones standalone Pi metadata into the native runtime cache, and `backend/src/workspace.rs`, `workspace_blob.rs`, `engine.rs`, and `project_discovery.rs` use Git for shadow repositories, worktrees, diffs, and publication. On Windows, Git for Windows also provides Git Bash used by tasks.

- **Tauri discovery & verification:**
  - GUI-launched desktop apps (especially on macOS Finder/Dock) often inherit a minimal `PATH`. Tauri must search inherited `PATH` plus standard platform locations:
    - **macOS:** `/opt/homebrew/bin/git`, `/usr/local/bin/git`, `/usr/bin/git`, `/Library/Developer/CommandLineTools/usr/bin/git`. Critically, execute `git --version` (without triggering interactive prompts, e.g., checking exit status / `xcode-select -p` or stub output) so Apple's uninstalled `/usr/bin/git` CLT shim is rejected rather than misidentified as working Git.
    - **Windows:** `PATH` (`git.exe`), `%ProgramFiles%\Git\cmd\git.exe`, `%ProgramFiles(x86)%\Git\cmd\git.exe`, `%LocalAppData%\Programs\Git\cmd\git.exe`. Also check for Git Bash availability for task execution diagnostics.
    - **Linux:** `PATH`, `/usr/bin/git`, `/usr/local/bin/git` (and optionally detect `bwrap` availability to surface a non-blocking warning for Graph isolation).
- **Propagate resolved Git to backend and scripts:**
  - Tauri sets `GRAPHER_TRUSTED_GIT` to the verified executable path and prepends its parent directory to the sidecar's `PATH` (when not already present).
  - Update `backend/src/native.rs::trusted_git()` to honor `GRAPHER_TRUSTED_GIT` first (canonicalized via `host_path()`) before scanning `PATH`.
  - Ensure backend host Git calls (`workspace.rs`, `workspace_blob.rs`, `engine.rs`, `project_discovery.rs`) and `scripts/prepare-native-runtime.mjs` use `trusted_git()` / `process.env.GRAPHER_TRUSTED_GIT || "git"` rather than assuming `git` is on ambient `PATH`.
- **Actionable preflight UI:**
  - Expose preflight results via Tauri IPC (e.g., `get_desktop_preflight` / `recheck_preflight`).
  - If Git is missing or unusable, keep the desktop app responsive and present clear, platform-specific installation guidance plus a re-check action instead of failing silently or crashing the sidecar.

### 2.4 Data directory management and guarded first-launch legacy copy

Bundled application directories (`.app`, `Program Files`, AppImage mountpoints) are read-only or replaced on upgrade, so persistent runtime state cannot live in `<installation-root>/.grapher`.

- **Desktop data directory:** Tauri resolves `app_data_dir()` (e.g., `~/Library/Application Support/<identifier>`, `%APPDATA%\<identifier>`, `${XDG_DATA_HOME:-~/.local/share}/<identifier>`) and sets `GRAPHER_DATA_DIR` to `app_data_dir()/data` before launching the sidecar (unless explicitly overridden by an external user environment variable when desired for debugging, or strictly owned by desktop launch).
- **Locked, non-destructive first-launch legacy copy:**
  - Runs **only** when the destination `app_data_dir()/data` does **not** yet exist and an eligible legacy `.grapher` store is found (for example, when transitioning from a previous local/archive installation with a known legacy store path containing `events.sqlite`).
  - **Exclusive locking:** Acquire an exclusive lock on the legacy source directory (using the same `runtime.lock` exclusion mechanism as `backend/src/runtime_lock.rs`) before copying so an actively running legacy Grapher instance cannot mutate SQLite/WAL files mid-copy. Also guard the destination parent with a migration lock so concurrent first launches cannot race.
  - **Atomic staging:** Copy legacy files (excluding `runtime.lock` and transient lock files; verifying SQLite + WAL/SHM consistency under the source lock) into a temporary sibling staging directory under `app_data_dir()` (e.g. `data.migrating-<uuid>`), sync, and atomically rename into `app_data_dir()/data`. On any error, clean up only the temporary staging directory and surface the error without touching either store.
  - **Strict non-destructive invariant:**
    - If `app_data_dir()/data` already exists (even if empty or already initialized), **skip migration completely**.
    - **Never** silently overwrite, merge into, or delete either the legacy store or the desktop destination store.
  - **Format compatibility:** Inside `app_data_dir()/data`, `backend/src/startup.rs` retains full authority over format-version admission (`format-1/` redirection if an incompatible schema is encountered).
- **Other stores:**
  - `PI_CODING_AGENT_DIR` continues to default to `~/.grapher/pi-agent` so existing provider logins carry over without duplicating secrets.
  - Disposable workspace/native-runtime caches continue using OS cache directories (`default_cache_root()`).
  - WebView `localStorage` remains isolated in the Tauri WebView profile; `src/services/appStorage.ts` already keys run metadata by `dataPath`.

### 2.5 Ephemeral port binding, readiness protocol, clean shutdown, and IPC

To avoid port collisions on user machines and eliminate orphaned backend/Node/Pi processes:

1. **Bind port `0` (`127.0.0.1:0`):**
   - Allow `GRAPHER_PORT=0` in `backend/src/server.rs::run()`.
   - After `tiny_http::Server::http(("127.0.0.1", port))`, read the actual OS-assigned port from `server.server_addr()` (`to_ip().port()`), and pass that resolved `bound_port` (never `0`) to `handle_http_request`, `is_trusted_host`, `is_trusted_origin`, and startup logs.

2. **Machine-readable readiness signal:**
   - Immediately after the HTTP server is bound and worker/shutdown threads are armed, emit a single flushed, machine-readable line on stdout (when enabled, e.g., via `--desktop-sidecar` or `GRAPHER_READY_PROTOCOL=1`), such as:
     ```json
     {"type":"grapher_ready","port":54321,"dataDir":"/path/to/app_data/data"}
     ```
   - `src-tauri` reads sidecar stdout until this ready message arrives (with a bounded startup timeout and stderr capture for diagnostics) before resolving the backend port to the frontend.

3. **Clean parent-stdin shutdown signal:**
   - Support a dedicated parent-stdin shutdown watcher in `backend/src/server.rs` (enabled in sidecar mode, e.g., `--stdin-shutdown` or `GRAPHER_SHUTDOWN_ON_STDIN_EOF=1`).
   - When the parent writes a graceful shutdown command (e.g., `shutdown\n`) **or** closes stdin (including when the Tauri shell crashes or is force-terminated by the OS), trigger the exact same graceful shutdown path already used by `SIGINT`/`SIGTERM`:
     - Stop background cleanup and partition prewarm threads.
     - Pause active runs or mark in-flight publication failed cleanly in SQLite.
     - Terminate all owned Node/Pi/provider/native-runtime process trees (`engine::terminate_all()`, `native::shutdown_runtime()`, `provider_auth::shutdown()`).
     - Close SSE subscribers, unblock `tiny_http`, and release `runtime.lock`.
   - On desktop exit (`RunEvent::ExitRequested` / `RunEvent::Exit`), `src-tauri` sends the shutdown signal / closes sidecar stdin, waits briefly (e.g., up to 5 seconds) for clean exit, and only force-kills the sidecar process tree as a last resort.

4. **Frontend IPC and loopback CORS/SSE compatibility:**
   - `src-tauri` exposes an IPC command (e.g., `get_backend_config` returning `{ port, baseUrl, status, preflight }`) and notifies the WebView if the sidecar fails or restarts.
   - Add a lightweight frontend API-base helper (e.g., `src/services/apiBase.ts`) used by `runtime.ts`, `providerAuth.ts`, `piExtensions.ts`, and `runtimeEvents.ts`:
     - In Tauri desktop mode (detected via Tauri runtime presence), resolve `baseUrl` (`http://127.0.0.1:<port>`) from IPC once at startup and route `fetch(`${baseUrl}/api/...`)` and `new EventSource(`${baseUrl}/api/events`)` through it.
     - In ordinary browser / Vite dev mode, `baseUrl` is `""`, keeping relative `/api/...` URLs intact.
   - Update `backend/src/server.rs` request trust checks for desktop WebView origins:
     - Keep `Host` strictly pinned to `127.0.0.1:<bound_port>` or `localhost:<bound_port>`.
     - Extend `origin_matches_allowlist` (or add explicit desktop-origin handling via `GRAPHER_ALLOWED_ORIGINS`) to accept `tauri://localhost` (macOS/Linux WebView) in addition to `http://tauri.localhost` / `https://tauri.localhost` (Windows WebView2).
     - On `GET /api/events`, permit SSE connections when `Origin` is present and explicitly trusted by `is_trusted_origin` (even if WebKit/WebView2 tags the loopback request `Sec-Fetch-Site: cross-site`), while continuing to reject untrusted cross-site browser origins.

### 2.6 Preserve ordinary `npm run dev` and browser workflows

Desktop packaging must remain strictly additive:

- `npm run dev` (`scripts/dev.mjs`), `npm run frontend`, `npm run backend`, and `npm run start` continue working without Tauri installed.
- `GRAPHER_PORT` continues defaulting to `1421`, Vite continues proxying `/api` to `127.0.0.1:${GRAPHER_PORT || 1421}`, and `GRAPHER_DATA_DIR` continues defaulting to `<installation-root>/.grapher` when unset.
- Relative `/api/...` requests and `EventSource("/api/events")` remain the default behavior in standard browsers.
- Existing test suites (`npm run test:backend`, `npm run test:frontend`, `npm run test:release`, `npm run test:bundle`, etc.) remain valid and unblocked.

### 2.7 Updater configuration and signing behavior

Desktop auto-updates use `tauri-plugin-updater` and `tauri-plugin-process` (`relaunch`), and user-level launch at login uses `tauri-plugin-autostart` (`MacosLauncher::LaunchAgent` on macOS, current-user `HKCU` Run on Windows), all under least-privilege Tauri v2 capability permissions (`src-tauri/capabilities/default.json`: `autostart:default`, `updater:default`, `process:allow-restart`, `core:app:allow-version`, `core:resources:allow-close`), and must degrade gracefully when signing secrets are absent:

- **Endpoint & public key configuration:**
  - `src-tauri/tauri.conf.json` configures the GitHub Releases updater endpoint `https://github.com/zhexusun10/grapher/releases/latest/download/latest.json`, `"requireSignedVersion": true`, `"windows": { "installMode": "passive" }`, and the `plugins.updater.pubkey` slot (plus optional compile-time `GRAPHER_UPDATER_PUBKEY` / `TAURI_UPDATER_PUBKEY` override in `src-tauri/src/lib.rs`).
  - Generate a minisign keypair offline via `npm run tauri -- signer generate -w ~/.tauri/grapher.key`. **Never commit the private key**—store it only in CI secrets (`TAURI_SIGNING_PRIVATE_KEY` and optional `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) and offline backup; embed only the matching public key string in `plugins.updater.pubkey` (or pass it at build time via `GRAPHER_UPDATER_PUBKEY`).
  - `bundle.createUpdaterArtifacts` remains `false` in the base `src-tauri/tauri.conf.json` so unsigned local and CI builds never fail for lack of a private signing key. Signed release builds generate and sign updater artifacts explicitly when `TAURI_SIGNING_PRIVATE_KEY` is present and fail closed unless a matching public key is configured.
- **Signed releases & platform install semantics:** Updater artifact signatures (`.sig` files and signed platform entries in `latest.json`) **require** the private signing key matching the embedded public key, and CI verifies all three desktop targets (`macos-arm64`, `macos-x64`, `windows-x64`) cryptographically before writing `latest.json`. The updater always verifies minisign signatures and signed versions before installing; an empty or mismatched public key fails closed rather than bypassing verification. On macOS, the app swaps `Grapher.app` in place and restarts via `tauri-plugin-process::relaunch()`. On Windows NSIS, `tauri-plugin-updater` shuts down the `grapher.exe` sidecar via `cleanup_before_exit()` (`SidecarShutdownGuard`), hands off to the signed `Grapher_<ver>_x64-setup.exe` with `/P /UPDATE /R`, and exits directly without calling `relaunch()`.
- **Unsigned CI and local builds:** When `TAURI_SIGNING_PRIVATE_KEY` is not configured:
  - Desktop builds **must still succeed** and produce/publish usable native installers (macOS `.dmg`, Windows NSIS `.exe`).
  - No fake or unsigned updater signatures are generated, and `create-release` omits `latest.json` so unsigned CI builds publish installers only without a broken feed.
  - App startup is never blocked or broken: the silent startup check runs after first render and stays quiet when no signed package is available for the current platform (e.g., no `latest.json` published or `"platforms": {}`). Manual checks in **Settings → Software Update** clearly explain that unsigned CI/local builds have no installable signed updater packages and point users to GitHub Releases.
  - Browser mode (`npm run dev` / `npm run build` outside Tauri) keeps all updater plugin imports behind the Tauri feature check (`src/services/updater.ts`) with zero Tauri globals required.

---

## 3. Implementation record & current status

All four workstreams from the architecture contract are implemented:

1. **Backend sidecar readiness & desktop support (`backend/`):**
   - `backend/src/native.rs`, `backend/src/provider_auth.rs`, `backend/src/pi_extensions.rs`, `backend/src/workspace.rs`, `backend/src/workspace_blob.rs`, `backend/src/engine.rs`, `backend/src/server/project_discovery.rs`, and `scripts/prepare-native-runtime.mjs` honor `GRAPHER_INSTALLATION_ROOT`, `GRAPHER_TRUSTED_NODE`, and `GRAPHER_TRUSTED_GIT`.
   - `backend/src/main.rs` and `backend/src/server.rs` support ephemeral port `0` (`server.server_addr()`), the machine-readable `grapher_ready` stdout line, parent-stdin EOF/command graceful shutdown, and Tauri WebView origin/SSE trust rules (`tauri://localhost`, `http://tauri.localhost`, `https://tauri.localhost`).
   - Covered by `backend/tests/desktop_sidecar.rs`.
2. **Frontend desktop transport, preflight, updater & autostart UI (`src/`):**
   - `src/services/apiBase.ts` resolves the sidecar loopback base URL via Tauri IPC and falls back to relative `/api/...` URLs in browser/dev mode across `runtime.ts`, `providerAuth.ts`, `piExtensions.ts`, and `runtimeEvents.ts`.
   - `src/services/updater.ts`, `src/hooks/useAppUpdater.ts`, `src/components/UpdateBanner.tsx`, and `src/components/UpdateSettings.tsx` implement silent startup update checks, Settings-driven manual checks, macOS relaunch, and Windows NSIS handoff.
   - `src/services/autostart.ts`, `src/hooks/useAutostart.ts`, and `src/components/AutostartSettings.tsx` expose OS-backed Launch at login under Settings.
   - `src/App.tsx`, `src/components/layout/Sidebar.tsx`, `src/components/modals/SettingsModal.tsx`, `src/styles.css`, and `src/styles-workbench.css` integrate Git preflight diagnostics and the macOS overlay titlebar inset.
   - Covered by `scripts/desktop-api-transport.test.ts`, `scripts/desktop-transport-ui.test.mjs`, `scripts/updater.test.ts`, and `scripts/autostart.test.ts`.
3. **Tauri v2 shell & local tooling (`src-tauri/`, `scripts/`):**
   - `src-tauri/` implements the Tauri v2 shell (`src-tauri/src/lib.rs`, `src-tauri/src/managed_git.rs`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, least-privilege capabilities in `src-tauri/capabilities/`, macOS entitlements in `src-tauri/Entitlements.plist` and `src-tauri/NodeEntitlements.plist`, and generated icons).
   - When no working host Git is found, `managed_git.rs` automatically downloads, SHA-256-verifies, and atomically installs a pinned portable Git runtime (`dugite-native` on macOS with a self-contained `bin/git-grapher` wrapper; `PortableGit` with Git Bash on Windows) into `app_data_dir()/tools/git/<id>/` and passes `GRAPHER_MANAGED_GIT_PATH` to the backend so it activates without restarting the sidecar.
   - `scripts/desktop-dev.mjs`, `scripts/desktop-icons.mjs`, `scripts/desktop-stage.mjs`, `scripts/desktop-build.mjs`, and `scripts/desktop-sign-macos.mjs` stage the frontend `dist/`, release Rust `grapher` binary, verified Pi/engine runtime, and pinned Node.js `22.19.0` binary into native installers (`.dmg` on macOS, NSIS `.exe` on Windows).
4. **Updater signing & CI release automation (`.github/workflows/release.yml`, `scripts/`):**
   - `scripts/desktop-signing.mjs` and `scripts/desktop-updater-manifest.mjs` enforce preflight keypair validation, Ed25519 payload/trusted-comment signature verification, and complete-target `latest.json` generation.
   - `src-tauri/tauri.conf.json` embeds the minisign updater public key (key ID `14EEF075426ED435`); the matching private key is kept offline and configured via GitHub Actions Secret `TAURI_SIGNING_PRIVATE_KEY` to activate signed updater feeds. Optional macOS Developer ID / notarization (`APPLE_*`) and Windows Authenticode (`WINDOWS_*`) secrets remain independent and optional.
   - Covered by `scripts/desktop-packaging.test.mjs`, `scripts/desktop-signing.test.mjs`, and `scripts/desktop-updater-manifest.test.mjs`; operational runbooks live in [Desktop releases & secrets](development/desktop-releases.md).
