# Desktop Release Automation & Secrets Guide

Grapher publishes both native Tauri v2 desktop installers and relocatable CLI/browser archives from [`.github/workflows/release.yml`](../../.github/workflows/release.yml) whenever a `v*` tag is pushed.

## Local desktop development and builds

Before building locally, install prerequisites for your host OS (Node.js 22.19+, npm, Git, stable Rust, and native linker tools—macOS Xcode Command Line Tools or Windows MSVC Build Tools) and run `npm ci --ignore-scripts && npm run pi:setup`.

- **Desktop dev mode (hot-reloading Vite + Tauri shell + debug backend):**
  ```sh
  npm run desktop:dev
  ```
- **Regenerate Tauri desktop icons from `assets/icon-dots.svg`:**
  ```sh
  npm run desktop:icons
  ```
  Derives the white rounded-square desktop app icon (`#FFFFFF` canvas with the `#4A4A4A` Grapher web mark) and regenerates `src-tauri/icons/{icon.png,32x32.png,128x128.png,128x128@2x.png,icon.icns,icon.ico}` via `@tauri-apps/cli`.
- **Stage bundled frontend, release backend, verified Pi runtime, and pinned Node.js `22.19.0` only:**
  ```sh
  npm run desktop:stage -- --target macos-arm64   # or macos-x64 / windows-x64
  ```
- **Build a native installer (`.dmg` on macOS, NSIS `.exe` on Windows):**
  ```sh
  npm run desktop:build -- --target macos-arm64 --output-dir .tmp/desktop-dist
  ```
  On Apple Silicon macOS, cross-building Intel `macos-x64` also works once `rustup target add x86_64-apple-darwin` is installed; production Intel releases build natively on `macos-15-intel` in CI. Windows NSIS installers must be built on Windows (`windows-latest` in CI).

### Data migration, host requirements, launch at login & macOS titlebar

- **Launch at login (macOS / Windows):** The desktop shell registers `tauri-plugin-autostart` v2 (`MacosLauncher::LaunchAgent` on macOS; per-user `HKCU\...\Run` on Windows, not an elevated Windows service) under least-privilege `autostart:default` (`allow-enable`, `allow-disable`, `allow-is-enabled`) in `src-tauri/capabilities/default.json` without requesting filesystem or shell permissions. Plugin registration never auto-enables startup on its own and degrades safely if initialization fails. **Settings → Desktop settings → Launch at login** queries the actual OS registration on open, applies changes immediately (independent of backend config save/cancel), rolls back visibly on error, and displays a browser-unavailable notice outside Tauri.

- **macOS overlay titlebar & native limitations:** `src-tauri/tauri.conf.json` configures `"titleBarStyle": "Overlay"` and `"hiddenTitle": true` on the `main` window (macOS-only keys in Tauri v2; Windows keeps its standard native titlebar and `"Grapher"` title, and browser mode is unaffected). On macOS, the native title text and titlebar separator below the traffic lights are hidden, while `.app-shell.is-tauri-macos` reserves a pure-white (`#FFFFFF`) top bar strip and `data-tauri-drag-region` (permitted only on macOS via `src-tauri/capabilities/macos-window.json`). Known macOS-only native limitations under Tauri v2 `TitleBarStyle::Overlay`:
  - Window dragging via `data-tauri-drag-region` requires the window to be focused first on macOS (upstream Tauri limitation [tauri#4316](https://github.com/tauri-apps/tauri/issues/4316)).
  - Native macOS titlebar/traffic-light geometry varies slightly across macOS releases; the `30px` inset (plus the `12px` card margin) leaves comfortable clearance below standard traffic lights without clipping the floating sidebar or workbench cards.

- The desktop shell stores persistent runtime data at `app_data_dir()/data` (`~/Library/Application Support/io.github.zhexusun10.grapher/data` on macOS; `%APPDATA%\io.github.zhexusun10.grapher\data` on Windows) and runs a locked, atomic, preserve-first copy from an existing legacy `.grapher` store (or `GRAPHER_LEGACY_DATA_DIR`) only when `data` does not yet exist.
- Node.js `22.19.0` and the pinned Pi runtime are bundled inside the installer. If no working host **Git** is detected on first launch, the desktop shell automatically downloads and SHA-256-verifies a portable Git runtime into `app_data_dir()/tools/git/<id>/` in the background (`dugite-native` on macOS, `PortableGit` with Git Bash on Windows) and exposes it to the backend via `GRAPHER_MANAGED_GIT_PATH` without requiring a restart; if offline or download fails, the banner offers **Retry download** and **Re-check** fallbacks.

## Workflow architecture

- **Trigger:** `push` of `v*` tags (for example `v1.9.9` or `v2.0.0-rc.1`).
- **Least-privilege permissions:** Top-level workflow permissions default to `contents: read`. Only the final `create-release` aggregation job elevates to `contents: write`.
- **Jobs:**
  1. `build-release` — builds and smoke-tests the relocatable archives (`grapher-linux-x64.tar.gz`, `grapher-macos-arm64.tar.gz`, `grapher-macos-x64.tar.gz`, `grapher-windows-x64.zip`) plus `.sha256` checksums.
  2. `build-desktop` — runs on separate native runners (`macos-15` for Apple Silicon `macos-arm64`, `macos-15-intel` for Intel `macos-x64`, and `windows-latest` for `windows-x64`). Each job runs [`scripts/desktop-build.mjs`](../../scripts/desktop-build.mjs), which stages the frontend `dist/`, release Rust `grapher` binary, verified pinned Pi/engine runtime, and pinned Node.js `22.19.0` binary (SHA-256 verified) via [`scripts/desktop-stage.mjs`](../../scripts/desktop-stage.mjs), builds the native installer, and optionally signs Tauri updater artifacts.
  3. `create-release` — waits for both `build-release` and `build-desktop`, downloads all artifacts into `release-assets/`, runs [`scripts/desktop-updater-manifest.mjs`](../../scripts/desktop-updater-manifest.mjs) to build and verify `latest.json` when signed updater artifacts are present, consolidates all asset checksums into a single `SHA256SUMS.txt` while pruning per-file `.sha256` and standalone `.sig` files (whose signatures are already embedded in `latest.json`), and creates or refreshes a **draft** GitHub Release.

## Pre-tag version checklist

Before creating a `v<X.Y.Z>` tag, keep all three desktop/package version fields aligned:

1. `package.json` (`version`)
2. `src-tauri/tauri.conf.json` (`version`)
3. `src-tauri/Cargo.toml` (`package.version`)

`build-desktop` validates version sync and checks `--verify-tag` against these files before compiling, preventing mismatched installer filenames or minisign version-binding errors.

## Updater & install capability matrix

| Path | Release artifacts & `latest.json` keys | Install & restart semantics | Required secrets / variables | Verification coverage |
| --- | --- | --- | --- | --- |
| **macOS signed update path** (`macos-arm64`, `macos-x64`) | `Grapher_<ver>_{aarch64,x64}.app.tar.gz` + `.sig`; keys `darwin-aarch64` / `darwin-aarch64-app` and `darwin-x86_64` / `darwin-x86_64-app` | `tauri-plugin-updater` verifies Ed25519 minisign signature + signed `version:` (`requireSignedVersion: true`), swaps `Grapher.app` in place, frontend closes the update handle, then calls `@tauri-apps/plugin-process` `relaunch()` (falls back to manual restart button if relaunch fails) | `TAURI_SIGNING_PRIVATE_KEY` (+ optional `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) **and** matching public key in `plugins.updater.pubkey` or `GRAPHER_UPDATER_PUBKEY`; Apple Developer ID / notarization secrets optional | Real Tauri CLI signing + Ed25519 payload/global verification, manifest & controller tests, and Rust shell tests |
| **Windows NSIS signed update path** (`windows-x64`) | `Grapher_<ver>_x64-setup.exe` + `.sig` (raw signed NSIS `.exe`, not `.nsis.zip`/`.msi`); keys `windows-x86_64` / `windows-x86_64-nsis` | `tauri-plugin-updater` verifies signature + signed `version:`, extracts `.exe`, runs `cleanup_before_exit()` (which drops `SidecarShutdownGuard` in `app.resources_table()` so `grapher.exe` exits before file replacement), launches NSIS with `/P /UPDATE /R`, and exits directly (`std::process::exit(0)`). Frontend does **not** call `relaunch()` and treats IPC teardown during handoff as a clean transition rather than a false error | Same `TAURI_SIGNING_PRIVATE_KEY` + matching public key (`plugins.updater.pubkey` or `GRAPHER_UPDATER_PUBKEY`) | Deterministic Windows target/manifest/signing tests, controller Windows NSIS handoff tests, and `windows-latest` CI builds. **Windows native runtime smoke testing is not available in this macOS environment.** |
| **Unsigned / manual-install builds** (macOS & Windows) | Native `.dmg` / NSIS `-setup.exe` installers (+ `.sha256`) and relocatable archives only; no `.sig` files and no `latest.json` published | Installers build and run normally; startup silent check stays quiet on missing `latest.json` (`unsigned-unavailable`); **Settings → Software Update** directs users to GitHub Releases. Any unsigned build with an empty or mismatched `pubkey` fails closed on signature verification (`signature` error) | None required (`TAURI_SIGNING_PRIVATE_KEY` unset) | Tested locally and in CI (`desktop-updater-manifest.test.mjs`, `updater.test.ts`, `desktop-packaging.test.mjs`) |
| **Browser mode** (`npm run dev`, CLI/archive) | Relocatable `grapher-*.tar.gz` / `.zip` archives | Updater plugin APIs are feature-gated behind `isTauriDesktop()` and never imported or invoked; Settings shows browser-mode notice and GitHub Releases link | None | Tested in `updater.test.ts` (zero Tauri globals) |

> **Environment limitation:** Windows native runtime smoke testing (executing the NSIS `.exe` installer, observing live WebView2 / `ShellExecuteW` updater handoff, or exercising real `HKCU\...\Run` launch-at-login registration) is **not available in this macOS environment**. Windows installers are compiled and validated in GitHub Actions on `windows-latest`, while Windows target configuration, NSIS `.exe` signature verification, non-relaunch NSIS handoff semantics, and launch-at-login controller/UI contracts are covered by deterministic automated tests locally.

## Release assets

| Target | Installer / Archive | Updater payload (when `TAURI_SIGNING_PRIVATE_KEY` is set) | `latest.json` platform keys |
| --- | --- | --- | --- |
| macOS Apple Silicon (`macos-arm64`) | `Grapher_<ver>_aarch64.dmg` | `Grapher_<ver>_aarch64.app.tar.gz` (signature embedded in `latest.json`) | `darwin-aarch64`, `darwin-aarch64-app` |
| macOS Intel (`macos-x64`) | `Grapher_<ver>_x64.dmg` | `Grapher_<ver>_x64.app.tar.gz` (signature embedded in `latest.json`) | `darwin-x86_64`, `darwin-x86_64-app` |
| Windows x64 (`windows-x64`) | `Grapher_<ver>_x64-setup.exe` | Reuses `Grapher_<ver>_x64-setup.exe` (signature embedded in `latest.json`) | `windows-x86_64`, `windows-x86_64-nsis` |
| Relocatable archives (all platforms) | `grapher-{linux-x64,macos-arm64,macos-x64}.tar.gz`, `grapher-windows-x64.zip` | — | — |
| Aggregated release metadata | `SHA256SUMS.txt` (single consolidated checksum file for all downloadable installers/archives) | `latest.json` (uploaded only when signed updater artifacts exist; standalone `.sig` files are verified and pruned before release upload) | — |

## Secrets, variables & the three independent signing concerns

Desktop releases involve **three independent signing concerns**. Each protects a different trust boundary, uses its own credentials, and can be enabled or omitted independently. All signing and notarization secrets are **optional**—missing secrets never break installer builds; the workflow clearly reports which signing paths are active or skipped and still publishes installers to the draft release.

| Signing concern | What it signs | Who verifies it | Secrets / Variables | If omitted |
| --- | --- | --- | --- | --- |
| **1. Tauri updater minisign signatures** | `.app.tar.gz` (macOS) and `-setup.exe` (Windows) updater payloads -> `.sig` files + `latest.json` | Grapher's compiled-in `tauri-plugin-updater` using the embedded Ed25519 minisign public key (`requireSignedVersion: true`) | Secrets: `TAURI_SIGNING_PRIVATE_KEY`, optional `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`<br>Variable or config: `GRAPHER_UPDATER_PUBKEY` **or** `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` | Unsigned installer-only release: `.dmg` / `-setup.exe` installers still build; `.sig` and `latest.json` are skipped; clients show `unsigned-unavailable` and link to GitHub Releases. |
| **2. macOS Developer ID signing & notarization** | Inside-out Mach-O binaries (`node`, `grapher`, `.node`/`.dylib`), `Grapher.app`, and `Grapher_<ver>_*.dmg` (with Hardened Runtime & entitlements) | macOS Gatekeeper / Apple notary service | Secrets: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`; optional notarization: `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_P8` (or `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`) | Falls back to inside-out ad-hoc Mach-O signing (`-`); macOS Gatekeeper warns on downloaded builds until opened via Privacy & Security or `xattr -dr com.apple.quarantine`. |
| **3. Optional Windows Authenticode signing** | `Grapher.exe` and the NSIS `Grapher_<ver>_x64-setup.exe` installer (applied **before** minisign so `.sig` covers the final signed `.exe`) | Windows SmartScreen & Authenticode / `signtool` | Secrets: `WINDOWS_CERTIFICATE` + `WINDOWS_CERTIFICATE_PASSWORD` (base64 `.pfx`), **or** `WINDOWS_CERTIFICATE_THUMBPRINT`, **or** `WINDOWS_SIGN_COMMAND` (Azure Trusted Signing / HSM)<br>Variable: optional `WINDOWS_TIMESTAMP_URL` (default `http://timestamp.digicert.com`, RFC 3161 TSP) | Unsigned NSIS `.exe` installer; Windows SmartScreen ("Windows protected your PC") warns on downloaded builds until users choose *More info → Run anyway*. |

> **Ordering invariant:** Native OS signing always runs **before** Tauri updater minisign signing—on macOS, `Grapher.app` is inside-out signed and optionally notarized/stapled *before* creating `.app.tar.gz` and `.app.tar.gz.sig`; on Windows, Authenticode signs `Grapher_<ver>_x64-setup.exe` *before* `tauri signer sign` creates `Grapher_<ver>_x64-setup.exe.sig`. Re-signing an artifact after generating its `.sig` invalidates the minisign signature.

### Step-by-step GitHub repository setup

In GitHub, open **Settings → Secrets and variables → Actions**. Note carefully which entries belong under the **Secrets** tab versus the **Variables** tab:

#### 1. Tauri updater minisign signing (Secrets + Variable)

1. Generate a minisign keypair offline on a trusted machine **outside the repository checkout** (the helper refuses paths inside the repo and sets mode `0600` on the private key without ever printing private key contents):
   ```sh
   npm run desktop:signing -- generate --output ~/.tauri/grapher-updater.key
   ```
   (For a passphrase-protected key, add `--password '<passphrase>'` or run `npm run tauri -- signer generate -w ~/.tauri/grapher-updater.key` interactively.)
2. Back up `~/.tauri/grapher-updater.key` offline in your password manager/vault. **Never commit `.key` files to Git.**
3. Configure the **public key** (`~/.tauri/grapher-updater.key.pub`, base64-encoded single-line string):
   - **Recommended (GitHub Actions Variable):** In **Settings → Secrets and variables → Actions → Variables → New repository variable**, create `GRAPHER_UPDATER_PUBKEY` with the exact contents of `~/.tauri/grapher-updater.key.pub`.
   - **Alternative (in-repo config):** Commit the exact base64 public key into `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` so local builds and CI builds automatically share the same public key.
   - Precedence (identical in `src-tauri/src/lib.rs`, `scripts/desktop-build.mjs`, `scripts/desktop-updater-manifest.mjs`, and `scripts/desktop-signing.mjs`): `GRAPHER_UPDATER_PUBKEY` → `TAURI_UPDATER_PUBKEY` → `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.
   - When `GRAPHER_UPDATER_PUBKEY` is set, `desktop-build.mjs` compiles it into the desktop binary via **both** `option_env!("GRAPHER_UPDATER_PUBKEY")` in `src-tauri/src/lib.rs` and Tauri's `--config` override. `src-tauri/build.rs` and `src-tauri/src/lib.rs` validate any non-empty public key at compile time and refuse raw or base64-encoded private keys.
4. Configure the **private key** in **Settings → Secrets and variables → Actions → Secrets → New repository secret**:
   - `TAURI_SIGNING_PRIVATE_KEY` — exact contents of `~/.tauri/grapher-updater.key`.
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — key passphrase if generated with a password; omit or leave empty for password-less (`--ci`) keys.

**Behavior in CI:**
- **Preflight fast-fail:** At the start of `build-desktop` (before `npm run pi:setup` and before compiling), `node scripts/desktop-signing.mjs check` validates the configured public key, decrypts/validates `TAURI_SIGNING_PRIVATE_KEY` (with `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`), derives its public key, and aborts immediately if the private key and public key do not match.
- **When `TAURI_SIGNING_PRIVATE_KEY` is present (signed release mode):**
  - A matching base64 minisign public key **must** be configured via `GRAPHER_UPDATER_PUBKEY` (Variable) or `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.
  - Every generated `.sig` is cryptographically verified against its payload bytes, the configured public key, and `--app-version` before upload.
  - `create-release` runs `scripts/desktop-updater-manifest.mjs --tauri-conf src-tauri/tauri.conf.json --require-pubkey --require-all-when-signed` and then runs `scripts/desktop-signing.mjs verify-manifest --require-all` as an independent post-generation gate, refusing to publish `latest.json` if any target (`macos-arm64`, `macos-x64`, `windows-x64`) is missing or fails Ed25519 verification.
- **When `TAURI_SIGNING_PRIVATE_KEY` is absent (unsigned installer-only mode):**
  - macOS `.dmg` and Windows NSIS `.exe` installers still build and upload normally (even if a valid public key is already configured in `tauri.conf.json` or `GRAPHER_UPDATER_PUBKEY`, so those installers can still auto-update once signed releases begin).
  - `.app.tar.gz` / `.sig` files and `latest.json` are skipped cleanly.

#### 2. macOS Developer ID signing & notarization (optional; Secrets)

Without Apple secrets, macOS builds use inside-out ad-hoc Mach-O signing (`scripts/desktop-sign-macos.mjs` with identity `-`) so bundled Node.js, `grapher`, and native `.node`/`.dylib` modules carry matching entitlements (`src-tauri/Entitlements.plist` and `src-tauri/NodeEntitlements.plist`).

**Certificate requirements:**
- Requires a **Developer ID Application** certificate (not "Apple Development" or "Mac App Distribution") issued by an active Apple Developer Program account, exported with its private key as a `.p12` file from Keychain Access.
- Hardened Runtime (`"hardenedRuntime": true` in `src-tauri/tauri.conf.json`) and secure timestamps (`--timestamp --options runtime`) are automatically enabled whenever a non-ad-hoc `APPLE_SIGNING_IDENTITY` is active.
- Nested binaries are signed strictly deepest-first without `--deep` so `NodeEntitlements.plist` (`allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation`) stays attached to bundled `node` and `.node`/`.dylib` modules while `Entitlements.plist` stays on `Grapher.app` and `grapher`.

Configure all three **Repository Secrets** for Developer ID signing:

| Secret | Description |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64-encoded Developer ID Application `.p12` export (`base64 -i cert.p12 \| tr -d '\n'`). |
| `APPLE_CERTIFICATE_PASSWORD` | Export password for the `.p12` file. |
| `APPLE_SIGNING_IDENTITY` | Exact signing identity string from `security find-identity -v -p codesigning`, e.g. `Developer ID Application: Example Corp (TEAMID1234)`. |

In CI, the `.p12` is decoded to `$RUNNER_TEMP` with mode `0600`, imported into a temporary keychain with a random password, immediately unlinked, and the temporary keychain is deleted in an `if: always() && matrix.platform == 'macos'` step.

**Notarization (optional; requires Developer ID signing):**

When Developer ID signing is active, Grapher notarizes and staples both `Grapher.app` (before building `.app.tar.gz`) and the `.dmg` installer via `xcrun notarytool submit --wait` + `xcrun stapler staple`. Configure **either** Option A (recommended) **or** Option B under **Repository Secrets**:

- **Option A — App Store Connect API key (recommended):**
  | Secret | Description |
  | --- | --- |
  | `APPLE_API_KEY` | App Store Connect API Key ID. |
  | `APPLE_API_ISSUER` | App Store Connect Issuer UUID. |
  | `APPLE_API_KEY_P8` | Contents of the `.p8` private key (raw PEM or base64-encoded PEM; written to `$RUNNER_TEMP` with mode `0600` and removed in `if: always()`). |
- **Option B — Apple ID + app-specific password:**
  | Secret | Description |
  | --- | --- |
  | `APPLE_ID` | Apple Developer account email address. |
  | `APPLE_PASSWORD` | App-specific password generated at `appleid.apple.com`. |
  | `APPLE_TEAM_ID` | 10-character Apple Developer Team ID. |

If credentials are partial (for example `APPLE_CERTIFICATE` without `APPLE_SIGNING_IDENTITY`, or notarization secrets without Developer ID signing), preflight emits a GitHub Actions `::warning::` listing the exact missing secret names and safely falls back without failing the build.

#### 3. Windows Authenticode / installer signing (optional; Secrets + optional Variable)

Without Windows code-signing credentials, `windows-latest` still builds and uploads `Grapher_<ver>_x64-setup.exe` (and signs it with the Tauri updater minisign key if configured), but downloaded installers will trigger Windows SmartScreen warnings.

**Certificate / PFX requirements:**
- Requires an Authenticode **Code Signing** certificate (X.509 with Code Signing EKU `1.3.6.1.5.5.7.3.3`).
- Standard OV `.pfx` certificates eliminate "Unknown publisher" errors once reputation builds, while **EV code signing** or **Azure Trusted Signing** provides immediate SmartScreen reputation.
- Signatures use **SHA-256** (`digestAlgorithm: "sha256"`) and **RFC 3161 timestamping** (`tsp: true`, defaulting to `http://timestamp.digicert.com`) so signed installers remain valid after the certificate expires.
- Export `.pfx` to single-line base64: `base64 -i cert.pfx | tr -d '\n'` (macOS/Linux) or `[Convert]::ToBase64String([IO.File]::ReadAllBytes('cert.pfx'))` (PowerShell).

Configure **one** of the following three modes in GitHub Actions:

- **Option A — Base64 `.pfx` certificate (Secrets):**
  | Type | Name | Description |
  | --- | --- | --- |
  | Secret | `WINDOWS_CERTIFICATE` | Base64-encoded `.pfx` / `.p12` Authenticode certificate. Decoded to `$RUNNER_TEMP`, imported into `Cert:\CurrentUser\My`, immediately unlinked, and removed from `Cert:\CurrentUser\My` in `if: always() && matrix.platform == 'windows'`. |
  | Secret | `WINDOWS_CERTIFICATE_PASSWORD` | Password protecting the `.pfx` file. |
  | Variable (optional) | `WINDOWS_TIMESTAMP_URL` | RFC 3161 timestamp server URL (defaults to `http://timestamp.digicert.com`). |
- **Option B — Custom sign command for Azure Trusted Signing / Cloud HSM / EV tokens (Secret):**
  | Type | Name | Description |
  | --- | --- | --- |
  | Secret | `WINDOWS_SIGN_COMMAND` | Custom Tauri `bundle.windows.signCommand` containing the `%1` binary path placeholder (e.g. an Azure Trusted Signing CLI or HSM `signtool` invocation). Passed to Tauri via a temporary `0o600` `--config` JSON file (never on CLI argv) and deleted immediately after build. |
- **Option C — Pre-imported certificate thumbprint (Secret):**
  | Type | Name | Description |
  | --- | --- | --- |
  | Secret | `WINDOWS_CERTIFICATE_THUMBPRINT` | 40-character hexadecimal SHA-1 thumbprint of a certificate already installed in the runner certificate store (used with SHA-256 + `WINDOWS_TIMESTAMP_URL`). |

## Local signing helper & dry-run verification

Use `npm run desktop:signing` (backed by [`scripts/desktop-signing.mjs`](../../scripts/desktop-signing.mjs)) to manage keys and run preflight or post-build verification locally without committing or printing any private key material:

```sh
# 1. Generate a new minisign keypair offline (outside the repo, chmod 0600 on private key)
npm run desktop:signing -- generate --output ~/.tauri/grapher-updater.key

# 2. Derive the base64 public key from an existing private key and check it against the app config/env
TAURI_SIGNING_PRIVATE_KEY_PATH=~/.tauri/grapher-updater.key \
  npm run desktop:signing -- derive-pubkey --check-configured

# 3. Preflight-check all three signing concerns for your current shell env
npm run desktop:signing -- check --tauri-conf src-tauri/tauri.conf.json

# 4. Dry-run signed mode preflight (fails fast on missing/mismatched/invalid keys)
GRAPHER_UPDATER_PUBKEY="$(cat ~/.tauri/grapher-updater.key.pub)" \
TAURI_SIGNING_PRIVATE_KEY_PATH=~/.tauri/grapher-updater.key \
  npm run desktop:signing -- check --require-updater-signing

# 5. Verify a standalone updater signature (.sig) against its payload and public key
npm run desktop:signing -- verify-signature \
  --artifact desktop-dist/Grapher_1.9.9_aarch64.app.tar.gz \
  --pubkey ~/.tauri/grapher-updater.key.pub \
  --version 1.9.9

# 6. Verify a generated latest.json manifest and all referenced payload files
npm run desktop:signing -- verify-manifest \
  --manifest release-assets/latest.json \
  --assets-dir release-assets \
  --pubkey ~/.tauri/grapher-updater.key.pub \
  --tag v1.9.9 \
  --require-all
```

## Key rotation implications

- **Rotating the Tauri updater minisign keypair (`TAURI_SIGNING_PRIVATE_KEY` + `GRAPHER_UPDATER_PUBKEY` / `tauri.conf.json`):**
  - `tauri-plugin-updater` pins a **single** Ed25519 public key in the compiled desktop binary.
  - Existing installations compiled with the **old** public key (or compiled with empty `pubkey: ""` in unsigned releases) **cannot** auto-update to releases signed with a **new** private key—they fail closed with `UnexpectedKeyId` / `InvalidEncoding` (`signature` error) and must perform a one-time manual reinstall from GitHub Releases to pick up the new public key.
  - Never rotate `TAURI_SIGNING_PRIVATE_KEY` without simultaneously updating `GRAPHER_UPDATER_PUBKEY` (or `src-tauri/tauri.conf.json`). CI preflight (`desktop-signing.mjs check`) automatically blocks releases where the private key and public key diverge.
  - Treat the minisign private key as long-lived release infrastructure: back it up securely offline and rotate only if compromised or intentionally migrating users with release notes directing a manual reinstall.
- **Rotating Apple Developer ID or Windows Authenticode certificates:**
  - Does **not** break Tauri minisign updater verification (those are independent trust layers).
  - On macOS, renewing a Developer ID Application certificate under the same Apple Team ID preserves continuity; changing Team IDs changes the designated requirement for Keychain/Gatekeeper continuity.
  - On Windows, switching to a new OV certificate can temporarily reset SmartScreen reputation until downloads accumulate (unless using EV or Azure Trusted Signing); RFC 3161 timestamping keeps previously released installers valid after the old certificate expires.

## Common signing errors & troubleshooting

| Symptom / Error | Root cause | Fix |
| --- | --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY is set, but no updater public key is configured` | `TAURI_SIGNING_PRIVATE_KEY` secret is set, `src-tauri/tauri.conf.json` has `"pubkey": ""`, and `GRAPHER_UPDATER_PUBKEY` is empty—most commonly because `GRAPHER_UPDATER_PUBKEY` was added under GitHub **Secrets** instead of **Variables**. | Create `GRAPHER_UPDATER_PUBKEY` under **Settings → Secrets and variables → Actions → Variables** (not Secrets), or commit the base64 public key into `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`. |
| `raw 2-line minisign text rather than the base64-encoded public key` / `not valid base64` | Raw `.pub` text (`untrusted comment: ...`) or truncated base64 was pasted into `GRAPHER_UPDATER_PUBKEY` / `tauri.conf.json`. | Use the exact base64 output printed by `npm run desktop:signing -- generate` or `derive-pubkey`. |
| `Refusing to accept private/secret key material` | The private `.key` contents (raw or base64-encoded) were pasted into `GRAPHER_UPDATER_PUBKEY` or `plugins.updater.pubkey`. | Replace with the companion `.key.pub` public key immediately; rotate the keypair if the private key was ever committed or exposed. |
| `Failed to decrypt TAURI_SIGNING_PRIVATE_KEY` | `TAURI_SIGNING_PRIVATE_KEY` is malformed/truncated, or `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` does not match the key's passphrase. | Test locally with `npm run desktop:signing -- derive-pubkey` and re-save `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` without extra shell escaping. |
| `Tauri updater signing keypair mismatch: ... derives key ID X, but ... has key ID Y` / `The signature was created with a different key` | `TAURI_SIGNING_PRIVATE_KEY` and `GRAPHER_UPDATER_PUBKEY` (or `tauri.conf.json`) belong to different keypairs, or an already-installed app has an older/empty embedded public key. | Run `npm run desktop:signing -- derive-pubkey` against the CI private key to get the exact matching public key and update `GRAPHER_UPDATER_PUBKEY` / `tauri.conf.json`. Existing installs compiled with an old or empty pubkey must manually reinstall once. |
| `failed Ed25519 payload signature verification` | The `.app.tar.gz` or `-setup.exe` was modified or re-signed (for example by Authenticode or re-archiving) *after* `.sig` generation, or corrupted in transit. | Always sign with `tauri signer sign` last, after native OS signing/notarization, and verify with `npm run desktop:signing -- verify-manifest --assets-dir ...`. |
| `missing a signed version in its trusted comment` / `SignedVersionMismatch` | `requireSignedVersion: true` is enabled in `tauri.conf.json`, and an artifact was signed without `--app-version <X.Y.Z>` or with a mismatched version. | Always sign via `scripts/desktop-build.mjs` (or pass `--app-version <X.Y.Z>` matching `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and the git tag). |
| `unsigned-unavailable` in app / `skipping latest.json` in CI / `Refusing to generate partial latest.json` | No `.sig` files were produced (unsigned installer-only release), or one of the three desktop targets (`macos-arm64`, `macos-x64`, `windows-x64`) failed to produce a `.sig` while others succeeded. | For unsigned releases this is expected—users install manually from GitHub Releases. For signed releases, ensure all three `build-desktop` targets succeed with `TAURI_SIGNING_PRIVATE_KEY` available. |
| macOS Gatekeeper warning ("cannot be verified" / "damaged") | macOS build used ad-hoc signing (`APPLE_*` secrets absent) or was Developer ID signed without Apple notarization. | Configure `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, plus App Store Connect API notarization secrets (`APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_P8`). For unsigned local/ad-hoc builds, clear quarantine or allow via System Settings → Privacy & Security. |
| Windows SmartScreen warning ("Windows protected your PC") | Windows NSIS `-setup.exe` was built without Windows Authenticode signing (`WINDOWS_*` secrets absent), or signed with a brand-new OV certificate that has not yet built SmartScreen reputation. | Configure `WINDOWS_CERTIFICATE` + `WINDOWS_CERTIFICATE_PASSWORD` (prefer EV or Azure Trusted Signing via `WINDOWS_SIGN_COMMAND`) and RFC 3161 timestamping (`WINDOWS_TIMESTAMP_URL`). |

## Secret hygiene & release safety guarantees

- **No secret interpolation in shell commands:** Every `${{ secrets.* }}` value is bound only to step-level `env:` blocks, never directly inside `run:` strings.
- **Process isolation:** `scripts/desktop-stage.mjs` and `scripts/desktop-build.mjs` strip updater (`TAURI_SIGNING_PRIVATE_KEY*`), Apple (`APPLE_*`), and Windows (`WINDOWS_CERTIFICATE*`, `WINDOWS_SIGN_COMMAND`) secrets from frontend (`vite`/`tsc`), Rust (`cargo build`), and Pi staging child environments; updater secrets are exposed only to `tauri signer sign`, and Tauri build config overrides are passed via temporary `0o600` JSON files rather than CLI argv.
- **Compile-time & runtime key validation:** `src-tauri/build.rs` and `src-tauri/src/lib.rs` reject raw or base64-encoded secret keys and malformed minisign public keys at compile time. `src-tauri/tauri.conf.json` enables `"requireSignedVersion": true` so clients reject unversioned or version-mismatched signatures at runtime. `scripts/desktop-signing.mjs`, `scripts/desktop-build.mjs`, and `scripts/desktop-updater-manifest.mjs` verify keypair derivation/match before compilation, verify Ed25519 payload + global trusted-comment signatures and Key ID equality after signing, enforce `--app-version` binding, reject partial signed feeds (`--require-pubkey --require-all-when-signed`), and re-verify `latest.json` before upload.
- **Temporary credential cleanup:** Both macOS temporary keychains/files (`.p12`, `.p8`) and Windows temporary `.pfx` files + imported `Cert:\CurrentUser\My` certificates are cleaned up in `if: always()` steps.
- **Published-release protection & draft idempotency:** Re-running the workflow on an unpublished draft refreshes assets idempotently (deleting removed/stale assets and uploading the new set with `--clobber`). If a release for the tag has already been published (`isDraft != true`), `create-release` refuses to modify it and exits non-zero.

## Verification & environment boundaries

### Commands

- Release, signing helper, & updater manifest contracts (no Rust build):
  ```sh
  npm run test:release
  ```
- Full desktop packaging, signing, & Tauri shell suite:
  ```sh
  npm run test:desktop
  ```
- TypeScript & updater controller tests:
  ```sh
  npm run check && node --import tsx --test scripts/updater.test.ts
  ```
- Test inventory check:
  ```sh
  npm run test:inventory
  ```
- Local signing helper usage & preflight:
  ```sh
  npm run desktop:signing -- --help
  npm run desktop:signing -- check
  ```

### What can vs. cannot be verified outside native runners / credentials

| Desktop capability / signing path | Verifiable locally / in static & unit tests (no Apple/Windows credentials) | Requires native macOS/Windows execution or signing credentials |
| --- | --- | --- |
| **Tauri updater minisign (keypair, signatures, `latest.json`)** | **Yes (end-to-end):** Keypair generation via `@tauri-apps/cli`, scrypt decryption & Ed25519 public-key derivation, private/public key match preflight, real `tauri signer sign --app-version`, Ed25519 payload + trusted-comment signature verification, `latest.json` generation & verification, Rust `build.rs`/`lib.rs` compile-time secret-key rejection, and frontend updater state-machine tests. | Live download/install/relaunch against a published GitHub Release requires native macOS / Windows desktop execution. |
| **Launch at login (`tauri-plugin-autostart`)** | **Static, plugin registration & mocked UI contracts:** Rust plugin registration (`MacosLauncher::LaunchAgent`), least-privilege `autostart:default` capability, `AutostartController` state/race/rollback tests, and browser/SettingsModal Playwright integration tests. | Live macOS LaunchAgent (`~/Library/LaunchAgents`) and Windows per-user registry (`HKCU\...\Run`) login execution requires native OS desktop sessions (no Windows local runtime smoke testing on macOS). |
| **macOS Developer ID signing & notarization** | **Logic & contracts only:** Mach-O header detection, deepest-first signing order, `Entitlements.plist` vs `NodeEntitlements.plist` selection, credential-group preflight & partial-secret warnings, env sanitization, and workflow secret-handling checks. | **Requires macOS runner + Apple Developer Program credentials:** `security import`, `codesign --timestamp --options runtime`, `xcrun notarytool submit`, `xcrun stapler staple`, and live Gatekeeper assessment (`spctl --assess`). |
| **Windows Authenticode & NSIS installer signing** | **Logic & contracts only:** PFX base64 / SHA-1 thumbprint / `WINDOWS_SIGN_COMMAND` (`%1`) / `WINDOWS_TIMESTAMP_URL` preflight validation, Tauri `--config` override generation (`bundle.windows.*`), secret sanitization, and workflow setup/cleanup contract checks. | **Requires `windows-latest` runner + Authenticode certificate (or Azure Trusted Signing/HSM):** `Import-PfxCertificate`, `signtool.exe` / `WINDOWS_SIGN_COMMAND` PE signing, NSIS `.exe` bundling, SmartScreen verification, and live Windows NSIS updater handoff. |
