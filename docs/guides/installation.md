# Installation and first run

Grapher runs locally with a browser UI and Rust backend. Model calls use your configured provider; local-first does not mean offline inference.

## Requirements

- Node.js **22.19+** and npm.
- Stable Rust/Cargo and the native compiler/linker required by your host toolchain.
- Git and network access for dependency installation and provider requests.
- A supported provider account/API key. See [Providers and models](providers.md).
- **Windows:** Git for Windows Bash and the Rust host build prerequisites; see [Windows](windows.md).
- **Linux Graph:** `/usr/bin/bwrap` from bubblewrap and permitted unprivileged user/mount/PID namespaces.
- **macOS Graph:** working `sandbox-exec`/Seatbelt support.

Only use projects, extensions, and tools you trust. Before important work, read the [execution model](../architecture/execution-model.md) and [filesystem boundaries](../architecture/filesystem-isolation.md).

## Install

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
| `GRAPHER_NATIVE_RUNTIME_PARENT` | Parent directory for the prepared shared Pi runtime |

Copy [.env.example](../../.env.example) to the Git-ignored `.env` only if needed. Never commit real credentials. Restart the backend after changing startup environment or engine adapters.

Node workspaces live beside the project in `.grapher-worktrees`; Planner copies use `.grapher-workspaces`. Keep enough disk space for Git snapshots, sessions, and logs. [Execution model](../architecture/execution-model.md#storage-and-cleanup) describes their lifecycles.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Missing Pi entrypoint or baseline mismatch | Initialize submodules, then run `npm run pi:setup` and `npm run pi:verify`; do not substitute global Pi |
| First build exceeds dev startup timeout | Build the backend first with `node scripts/cargo.mjs build --manifest-path backend/Cargo.toml --bin grapher`, then rerun `npm run dev` |
| Port already in use | Stop the process that owns it or change the backend port consistently; dev does not kill unrelated listeners |
| Provider/model unavailable | Authenticate in Settings, refresh the provider catalog, and select an available model |
| Graph isolation preflight fails | Check platform prerequisites/container namespace policy; do not disable isolation to mask the error |
| Bound project missing/inaccessible | Re-select the intended project; Grapher does not search for a replacement automatically |
| Publication fails | Inspect the retained state, resolve the actual Git/dirty-directory issue, then retry publication |
| Existing data format/log issues | Back up and read [Conversation-log maintenance](../testing/conversation-logs.md) before migration |

Next: [Providers](providers.md) · [Windows](windows.md) · [Development guide](../development/contributing.md)
