# Installation and first run

Grapher runs locally with a browser UI and Rust backend. Model calls use your configured provider; local-first does not mean offline inference.

## Requirements

- Node.js **22.19+**; npm is needed for source installation.
- For source builds only: stable Rust/Cargo and the native compiler/linker required by your host toolchain. Release archives include the compiled backend.
- Git and network access for dependency installation and provider requests.
- A supported provider account/API key. See [Providers and models](providers.md).
- **Windows:** Git for Windows Bash; source builds also need the Rust host build prerequisites. See [Windows](windows.md).
- **Linux Graph:** `/usr/bin/bwrap` from bubblewrap and permitted unprivileged user/mount/PID namespaces.
- **macOS Graph:** working `sandbox-exec`/Seatbelt support.

Only use projects, extensions, and tools you trust. Before important work, read the [execution model](../architecture/execution-model.md) and [filesystem boundaries](../architecture/filesystem-isolation.md).

## Install a release archive

Release archives are prebuilt: the backend binary, frontend, pinned Pi runtime and bundled extensions are inside. No Rust toolchain, npm installation or compilation is needed. At runtime you still need:

- **Node.js 22.19+** and **Git** on `PATH` — agent processes and provider login run through them. The packaged start script checks both and prints exact install guidance when something is missing.
- **Windows:** Git for Windows (it includes the Bash that tasks run in).
- **Linux Graph:** `bubblewrap` plus permitted unprivileged user/mount/PID namespaces.

Download the archive for your platform from [GitHub Releases](https://github.com/zhexusun10/grapher/releases) — macOS has separate `arm64` (Apple Silicon) and `x64` (Intel) packages; `uname -m` shows which one matches — and verify the accompanying `.sha256` checksum:

```sh
# macOS / Linux
shasum -a 256 -c grapher-macos-arm64.tar.gz.sha256
tar -xzf grapher-macos-arm64.tar.gz
```

```powershell
# Windows PowerShell
(Get-FileHash .\grapher-windows-x64.zip -Algorithm SHA256).Hash.ToLower() -eq (Get-Content .\grapher-windows-x64.zip.sha256).Split(' ')[0]
```

Extract the entire archive into a writable directory, preserving its directory structure and hidden Pi Git metadata (`.git` inside `pi/`), then start it:

- **Windows:** double-click `start.bat`, or run it in a terminal. The first launch may show a SmartScreen prompt ("Windows protected your PC") because releases are unsigned; choose **More info** → **Run anyway**. The launcher verifies Node.js and Git (including the 22.19+ version) and keeps the console open with the exit code if Grapher stops.
- **macOS:** `cd grapher-macos-arm64 && ./start.sh`. The launcher removes Apple's download quarantine mark from this extracted folder automatically; if the binary is still blocked, right-click `grapher` → **Open**, or run `xattr -dr com.apple.quarantine .` inside the folder.
- **Linux:** `cd grapher-linux-x64 && ./start.sh`.

Open **<http://127.0.0.1:1421>** (`GRAPHER_PORT` changes the port). The package contains a short `START-HERE.md` covering first steps, data location and troubleshooting.

Runtime data defaults to `.grapher/` inside the extracted installation; back it up before replacing an installation. The start scripts never download anything and never request administrator rights: missing prerequisites are reported, not auto-installed.

## Install from source

Run from a terminal; on Windows these shell commands can be used in Git Bash.

```sh
git clone --recurse-submodules https://github.com/zhexusun10/grapher.git
cd grapher
npm run dev
```

`npm run dev` automatically checks host tools, initializes the pinned Pi submodule, installs locked dependencies, and compiles the backend. For step-by-step setup or troubleshooting, you can also run `npm ci --ignore-scripts` followed by `npm run pi:setup`.

Open **<http://127.0.0.1:1420>**. Cargo compilation can make the first startup slower. The repository uses a pinned Pi submodule, not your globally installed Pi.

For an existing clone:

```sh
git submodule update --init --recursive
npm ci --ignore-scripts
npm run pi:setup
```

To install bubblewrap on Debian/Ubuntu:

```sh
sudo apt-get update
sudo apt-get install bubblewrap build-essential git
```

Installing the package does not enable namespaces prohibited by the host/container policy. Failed Graph preflight is an explicit error, not an unisolated fallback.

## Configure a first task

1. Open **Settings** and select a local project directory. Git repositories and ordinary folders are supported.
2. Authenticate a provider and select an available `provider/model`; see [Providers](providers.md).
3. Start with a disposable project and a small coding goal.
4. Auto routes simple work to Serial and independent workstreams to Graph. Explicit Serial/Graph modes are also available.
5. For Graph, review node tasks, dependencies, and feedback, then approve the plan.
6. Inspect node logs and the publication result. A Graph is not complete until valid results reach the project.

**Planning and approval can change your project.** Planner runs directly in the source, and native Bash writes are immediately visible before graph approval, even if planning fails or is cancelled. Git snapshots force-collect project files except Runtime/managed-environment internals. Rejecting the plan does not roll back those writes or side effects. See [Planning and approval](../architecture/execution-model.md#planning-and-approval).

Graph node dependencies are not automatically installed. Runtime force-collects project files into Git snapshots, including paths that `.gitignore` would normally hide; managed environment scopes/caches remain outside project Git. Linear dependencies and applied feedback reuse Git workspaces, while fan-out branches use independent worktrees. Git therefore handles additions, modifications, deletions, and conflicts for all project files. Very large files are not rejected automatically; Git/LFS/artifact storage policy is a project decision. See [Workspace directories and Git publication](../architecture/workspace-snapshots-and-feedback.md).

## Local production mode

```sh
npm run build
npm start
```

Open **<http://127.0.0.1:1421>**. This is a local server, not a hosted service.

`GRAPHER_PORT` changes the backend port. If you run `npm run backend` and `npm run frontend` separately, both need the same setting so the Vite API proxy reaches the backend.

Do not expose the API to untrusted clients or treat `GRAPHER_ALLOWED_ORIGINS` as authentication. Origin configuration is not an authorization system.

## Configuration and data

| Setting | Meaning |
| --- | --- |
| `GRAPHER_PORT` | Backend port; defaults to `1421` |
| `GRAPHER_DATA_DIR` | Runtime database, planning records, and sessions; defaults to `.grapher/` |
| `PI_CODING_AGENT_DIR` | Dedicated Pi configuration/credentials; defaults to `~/.grapher/pi-agent` |
| `GRAPHER_CACHE_DIR` | OS cache root; Windows defaults to `%LOCALAPPDATA%\Grapher`, macOS to `~/Library/Caches/Grapher`, Linux to `${XDG_CACHE_HOME:-~/.cache}/grapher` |
| `GRAPHER_WORKSPACE_PARENT` | Node-workspace parent; defaults to the cache root's `workspaces/` |
| `GRAPHER_NATIVE_RUNTIME_PARENT` | Shared engine-cache parent; defaults to the cache root's `workspaces/.grapher-workspaces/` |

Copy [.env.example](../../.env.example) to the Git-ignored `.env` only if needed. Never commit real credentials. Restart the backend after changing startup environment or engine adapters.

Node checkouts live in the configured cache's `.grapher-worktrees`; modern Planners work directly in the source, without project copies. The verified Pi engine/dependencies are cached once per content/platform version and shared across projects and backend restarts, not copied per workspace. Runtime records and existing execution paths are unchanged. Keep enough disk space for Git working trees and object storage, including files that `.gitignore` would normally hide, plus sessions and logs. Linear handoff and reclaimed workspace slots avoid retaining a separate checkout for every historical node. [Execution model](../architecture/execution-model.md#storage-and-cleanup) describes their lifecycles.

To inspect old project-adjacent leftovers, stop the relevant backends and run `npm run cleanup:workspaces -- --parent /absolute/path/to/old/project-parent --legacy-engines`; add `--apply` only after reviewing the preview. Unmarked legacy engines require **all** backends stopped.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Windows SmartScreen or macOS Gatekeeper blocks the release binary | Approve the unsigned binary once (Windows: More info → Run anyway; macOS: right-click → Open); the packaged start script also clears the macOS quarantine mark automatically |
| Missing Pi entrypoint or baseline mismatch | Initialize submodules, then run `npm run pi:setup` and `npm run pi:verify`; do not substitute global Pi |
| Graph runtime prewarm reports missing/outdated `pi-trim` or `pi-continuity` | For a source checkout, run `npm ci --ignore-scripts` from the Grapher root and restart the backend; `pi:setup` installs Pi dependencies, not these bundled extensions. For a release, re-extract the complete archive |
| First build exceeds dev startup timeout | Build the backend first with `node scripts/cargo.mjs build --manifest-path backend/Cargo.toml --bin grapher`, then rerun `npm run dev` |
| Port already in use | Stop the process that owns it or change the backend port consistently; dev does not kill unrelated listeners |
| Provider/model unavailable | Authenticate in Settings, refresh the provider catalog, and select an available model |
| Graph isolation preflight fails | Check platform prerequisites/container namespace policy; do not disable isolation to mask the error |
| Bound project missing/inaccessible | Re-select the intended project; Grapher does not search for a replacement automatically |
| Publication fails | Inspect the retained state, resolve the actual Git/dirty-directory issue, then retry publication |
| Existing data format/log issues | Back up and read [Conversation-log maintenance](../testing/conversation-logs.md) before migration |

Next: [Providers](providers.md) · [Windows](windows.md) · [Development guide](../development/contributing.md)
