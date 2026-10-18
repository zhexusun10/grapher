# Development guide

This guide is for contributors changing Grapher itself. For application use, follow the [README quick start](../../README.md#quick-start). [Architecture](../architecture/overview.md) explains system boundaries; the [task index](../index.md#task-routes) locates implementation and tests.

## Set up a checkout

Install Node.js 22.19+, npm, Git, stable Rust, and native compiler/linker tools. Windows needs Git for Windows Bash and the linker for the selected Rust toolchain; macOS needs Xcode Command Line Tools. Linux Graph execution needs bubblewrap and permitted unprivileged user/mount/PID namespaces. Initial setup needs network access.

```sh
git clone --recurse-submodules https://github.com/zhexusun10/grapher.git
cd grapher
npm ci --ignore-scripts
npm run pi:setup
npm run dev
```

The UI runs at `127.0.0.1:1420`, with `/api` proxied to the local backend at `1421` by default. The first Cargo build can take several minutes.

For separate terminals, use `npm run frontend` and `npm run backend`, exporting the same `GRAPHER_PORT` to both if you change it. The combined dev launcher loads `.env` or `backend/.env`; the standalone Vite command reads the backend port from its process environment.

After dependency setup, `npm run build` followed by `npm start` serves the production UI at `http://127.0.0.1:1421` (or the configured backend port), without Vite.

## Code ownership

| Area | Responsibility |
| --- | --- |
| `backend/src/` | Compiler, event-driven runtime, workspaces, publication, storage, local API |
| `src/` | UI, graph projection, conversation navigation, transcript loading |
| `engine/` | Pi compatibility/launcher, provider bridge, Graph tool/path adaptation |
| `backend/resources/` | Production prompts and Planner graph-tool contracts |
| `scripts/`, `backend/tests/` | Setup, maintenance, and regression harnesses |
| `benchmark/` | Harbor installed-agent adapter and evaluation support |
| `pi/` | Upstream execution/model/provider/auth implementation |

Keep Pi unmodified unless deliberately updating the pinned baseline. Do not patch a global Pi installation or depend on uncommitted submodule edits. See [Pi integration](pi-integration.md).

## Design rules

- Keep deterministic graph checks, scheduling, and publication decisions in Rust—not an LLM coordinator or browser heuristic.
- Treat backend events/Snapshots as authoritative. The frontend must not manufacture completed status.
- Distinguish task nodes, recorded execution attempts, and reused Pi sessions.
- Describe ordinary dependencies and applied feedback as inheritance of complete Git project state, not conversation exchange. Physical Run directories are reusable node/Merger single-writer worktrees: ordinary chains can hand them off, fan-out branches remain independently writable, and feedback retains separate control-flow rules. A Planner follow-up may share the newest workspace with its active writer. Git snapshots/commits are host implementation details, not an agent collaboration protocol.
- Preserve explicit feedback targets and limits, invalidation scope, and the publication completion boundary.
- Do not describe independent Git repositories or Windows Job Objects as security sandboxes.
- Do not silently downgrade failed platform preflight, provider errors, or interrupted execution into success.
- Preserve user data and failed-workspace evidence unless the user explicitly resets/deletes it.

A proposed runtime change should identify affected invariants and include regressions for failure as well as the happy path.

## Before submitting a change

Select relevant checks from [Testing](testing.md); include integration/platform checks when the changed behavior needs them. Report actual commands and results, plus relevant validation gaps—not a list of unrelated suites that were not run.

Describe behavior changes and effects on persisted state or credentials. Keep generated evidence separate from source.

## Documentation policy

English is canonical under `docs/`; [README.zh-CN.md](../../README.zh-CN.md) remains the Chinese product entrypoint.

- **User documentation:** README pages explain the product and the shortest usable startup path. Keep them concise; do not require readers to understand implementation contracts or run contributor tests.
- **Developer documentation:** Explain the relevant scope, prerequisites, mechanisms, rationale, and verification limits. Distinguish implemented behavior from proposals and design goals; link focused implementation/tests rather than treating intent as proof.
- **Agent instructions:** Follow the [instruction-file constraints](../../AGENTS.md#instruction-scope); keep task-specific rationale and procedures in developer documentation, not automatically loaded instructions.
- Update the single canonical page when behavior changes, and link implementation/tests instead of copying volatile constants or UI details.
- Do not add a second explanation of an existing contract, a dated verification log, or a local run report.
- Keep sensitive logs and local reports in ignored runtime/output directories, not public documentation.

When behavior changes, update the relevant canonical page and any affected README/translation summary. [docs/index.md](../index.md) is the discovery path; source, tests, and CI are the final authority.

For log migration, see [Conversation logs](../testing/conversation-logs.md).

## Licensing and sensitive data

Grapher's original code uses [MIT](../../LICENSE); the Pi submodule and other dependencies retain their own licenses. Preserve applicable notices and confirm rights to contributions/assets. Never commit API keys, auth directories, local `.env`, or unreviewed traces containing private code and prompts.
