# Development guide

Grapher uses a React/TypeScript UI, a Rust backend, and a pinned upstream Pi submodule. Start with [Installation](../guides/installation.md), then [Architecture](../architecture/overview.md).

## Set up a checkout

```sh
git clone --recurse-submodules https://github.com/zhexusun10/grapher.git
cd grapher
npm ci --ignore-scripts
npm run pi:setup
npm run pi:verify
npm run dev
```

Use `npm run frontend` and `npm run backend` for separate terminals if needed; keep their `GRAPHER_PORT` setting consistent. The UI runs at `127.0.0.1:1420`, with `/api` proxied to the local backend at `1421` by default.

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
- Describe ordinary dependencies and applied feedback as inheritance of completed workspace state, including ignored project files, not conversation exchange. Physical Run directories are reusable single-writer slots: ordinary chains can hand them off, parallel branches remain independently writable, and feedback retains separate control-flow rules. Git snapshots/commits are host implementation details, not an agent collaboration protocol.
- Preserve explicit feedback targets and limits, invalidation scope, and the publication completion boundary.
- Do not describe independent Git repositories or Windows Job Objects as security sandboxes.
- Do not silently downgrade failed platform preflight, provider errors, or interrupted execution into success.
- Preserve user data and failed-workspace evidence unless the user explicitly resets/deletes it.

A proposed runtime change should identify affected invariants and include regressions for failure as well as the happy path.

## Before submitting a change

Run the checks appropriate to the affected area:

```sh
npm run check
npm run build
npm run test:frontend
npm test
```

Engine/provider/tool changes additionally need Pi contracts and applicable native/extension/binding tests. Platform changes need checks on the actual platform. [Testing](testing.md) explains prerequisites and what each suite can establish.

Include a clear description of behavior, tests run, known limits, and any change to persisted state or credentials. Separate generated evidence from source. Do not claim a model-quality or sandbox guarantee based on fixtures alone.

## Documentation policy

English is canonical under `docs/`; [README.zh-CN.md](../../README.zh-CN.md) remains the Chinese product entrypoint.

- User guides explain setup, supported behavior, failure recovery, and meaningful limits.
- Architecture documents explain current contracts and invariants; link code for low-level details.
- Tool prompts/contracts stay beside their implementations where they directly affect behavior.
- Evaluation guides specify reproducible environments and evidence requirements, not private run diaries.
- Replace duplicate contracts with links. Label useful superseded proposals/reviews as historical and link their current authority; do not treat them as implemented requirements.
- Keep sensitive logs and local reports in ignored runtime/output directories, not public documentation.
- Keep every knowledge page discoverable from the [task-oriented index](../index.md). Root/local AGENTS.md files are navigation and development constraints, not architecture manuals.

Follow [Documentation maintenance](documentation.md) for placement, statuses, related-code links, review triggers and agent exploration evaluation. When behavior changes, update the relevant canonical page and any affected README/translation summary. Do not create a second long document with a conflicting contract. Check references and navigation with:

```sh
npm run check:docs
```

For log migration, see [Conversation logs](../testing/conversation-logs.md). Repository About-field maintenance is documented in [Repository homepage settings](../../.github/repository-homepage.md).

## Licensing and sensitive data

Grapher's original code uses [MIT](../../LICENSE); the Pi submodule and other dependencies retain their own licenses. Preserve applicable notices and confirm rights to contributions/assets. Never commit API keys, auth directories, local `.env`, or unreviewed traces containing private code and prompts.
