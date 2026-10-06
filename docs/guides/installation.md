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

Download the archive for your operating system and CPU from [GitHub Releases](https://github.com/zhexusun10/grapher/releases) and verify its accompanying SHA256 checksum. macOS has separate `arm64` (Apple Silicon) and `x64` (Intel) packages; the macOS packages are built and smoke-tested on macOS 15.

Extract the entire archive into a writable directory, preserving its directory structure and hidden Pi Git metadata. On Linux/macOS run `./start.sh` inside the extracted directory; on Windows run `start.bat`. Open **<http://127.0.0.1:1421>**.

Archives include the backend, frontend, pinned Pi runtime, and bundled extensions. You still need Node.js and Git on `PATH`, platform sandbox prerequisites, provider authentication, and any tools required by your tasks (including Git Bash on Windows). No Rust build or npm installation is needed to start an archive. Runtime data defaults to `.grapher/` inside the extracted installation; back it up before replacing an installation.

## Install from source

Run from a terminal; on Windows these shell commands can be used in Git Bash.

```sh
git clone --recurse-submodules https://github.com/zhexusun10/grapher.git
cd grapher
npm ci --ignore-scripts
npm run pi:setup
npm run dev
```

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

**Planning and approval can change your project.** Planner runs directly in the source, and native Bash writes are immediately visible before graph approval, even if planning fails or is cancelled. Snapshots can stage and commit existing non-ignored user changes. Rejecting the plan does not roll back those writes or side effects. See [Planning and approval](../architecture/execution-model.md#planning-and-approval).

Graph node dependencies are not automatically installed. Ignored, untracked dependency files are not automatically included in inherited workspace snapshots; tasks must prepare the dependencies they need.

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

Node checkouts live in the configured cache's `.grapher-worktrees`; modern Planners work directly in the source, without project copies. The verified Pi engine/dependencies are cached once per content/platform version and shared across projects and backend restarts, not copied per workspace. Runtime records and existing execution paths are unchanged. Keep enough disk space for Git snapshots, sessions, and logs. [Execution model](../architecture/execution-model.md#storage-and-cleanup) describes their lifecycles.

To inspect old project-adjacent leftovers, stop the relevant backends and run `npm run cleanup:workspaces -- --parent /absolute/path/to/old/project-parent --legacy-engines`; add `--apply` only after reviewing the preview. Unmarked legacy engines require **all** backends stopped.

## Troubleshooting

| Symptom | Check |
| --- | --- |
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
