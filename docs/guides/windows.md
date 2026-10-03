# Windows guide

Windows Graph execution is implemented using **native host processes and independent Git repositories**. This is the current execution model, not a sandbox proposal or migration plan.

## Prerequisites and startup

Install Node.js 22.19+, Git for Windows (including Bash), and stable Rust with its required native linker/build tools. The standard Windows MSVC Rust toolchain needs the appropriate Visual Studio C++ Build Tools/Windows SDK.

In Git Bash, follow [Installation](installation.md). In PowerShell, use npm's command shim if script execution policy blocks `npm.ps1`:

```powershell
git clone --recurse-submodules https://github.com/zhexusun10/grapher.git
cd grapher
npm.cmd ci --ignore-scripts
npm.cmd run pi:setup
npm.cmd run dev
```

Open <http://127.0.0.1:1420> and configure a provider in Settings.

## What Windows provides

- Stock Node, pinned Pi, and Git for Windows Bash; no patched Node/MSYS binaries.
- Source-native Planner execution with immediate Bash writes, and independent Graph node repositories derived from source snapshots.
- Graph compilation, approval, concurrent branches, parent-to-child workspace inheritance, bounded feedback, and final publication.
- Process-tree management through Windows Job Objects. A child is attached while suspended, then resumed; kill-on-close supports termination with its owning backend.

Planner uses Pi's native Bash tool. Grapher does not substitute PowerShell or change Bash's shell semantics.

## What Windows does not provide

**Private repositories are not filesystem sandboxes.** Windows executes with the host user's permissions. The source project, siblings, other sessions, engine files, HOME, external resources, and credentials can be accessed wherever that user has access.

There is no per-node filesystem access boundary, VM, AppContainer policy, third-party isolation driver, or malicious-tenant guarantee. A Job Object controls lifecycle, not file permissions. Use only trusted projects, extensions, and toolchains.

macOS/Linux have separate filesystem boundary policies; Windows matches the Graph workflow, not those access restrictions. See [Filesystem isolation](../architecture/filesystem-isolation.md).

## Path behavior

- Prefer project-root-relative paths in tasks and generated configuration.
- For Windows-native programs invoked from Bash, `C:/...` paths are generally preferable to Bash mount syntax.
- Graph path adaptation recognizes supported drive, slash, extended-path, UNC, Git Bash `/c/...`, and `cygpath` mount spellings.
- Rust extended path prefixes are converted to paths accepted by stock Node's CLI/module loader; UNC paths retain UNC meaning.
- Existing script files and dynamically constructed paths are not transparently redirected. A hardcoded source path can operate on the real source under host permissions.

Native Git Bash argv/escaping constraints still apply. Grapher does not alter shell semantics to conceal unsupported path behavior.

The shared Pi runtime is prepared outside the source. `GRAPHER_NATIVE_RUNTIME_PARENT` changes its parent directory; restart the backend after adapter changes. Managed search-tool copies do not require administrator-only symlink creation and do not overwrite existing local tools.

## Verification

Run from a configured development checkout:

```powershell
npm.cmd run test:windows-native
npm.cmd run test:native
npm.cmd run test:extensions
npm.cmd run test:bindings
npm.cmd run test:pi
npm.cmd test
npm.cmd run check
npm.cmd run build
```

`test:windows-native` uses the production Rust backend, real pinned Pi, Planner extension, Git, and Bash. Only model responses come from a temporary local OpenAI-compatible service; this is not an external-model quality benchmark or fixture-engine substitute.

Coverage includes Bash/native tool semantics, concurrent Graph workflows, workspace inheritance/publication, cancellation of selected descendant writers, and interrupted-run recovery. Unknown third-party tools, detached services, and other crash conditions still require independent checks.

For offline extension tests, install `ripgrep` and `fd` first; see [Testing](../development/testing.md#search-tools-and-offline-runs). The [Windows CI workflow](../../.github/workflows/windows-native.yml) records the checks configured for the hosted runner, not a guarantee for every Windows installation.
