# Grapher

[简体中文](README.md)

> **Don't orchestrate agents. Compile work.**

Grapher is a local multi-agent coding system. It routes a goal to a single task or compiles it into an inspectable execution graph. A deterministic Rust runtime schedules independent Pi execution instances, combines results through Git file states, and declares completion only after successfully publishing to the user's project. 

Unlike chat-based agent orchestration, the planner exits after compilation rather than managing nodes during execution. Agents exchange Git file states, not conversation transcripts. Retries and feedback are explicit, bounded state transitions. A graph is complete only after its valid results reach the user's project. Linear work stays serial; more agents are not automatically better.

## Why not just another multi-agent system?

A common approach is to have an LLM continuously break down work, delegate to subagents, read their replies, and decide what to do next. This is flexible, but it hides scheduling in a conversation: failures, retries, concurrency, dependency invalidation, and completion are difficult to reproduce. Grapher assigns deterministic work to software and judgment to models, using a graph to define the task and collaboration structure:

| Question | Grapher's approach |
| --- | --- |
| Who decides the task structure? | The Partitioner chooses `serial` or `graph`; the Planner produces nodes, dependencies, and explicit feedback edges; the Compiler validates the graph statically; the user approves a graph. The Planner does not remain in charge during execution. |
| Who decides what runs next? | A Rust state machine schedules according to the compiled DAG, dependencies, concurrency limits, and feedback waves—not the next message from a coordinator. |
| What do agents exchange? | **Filesystem state** represented by Git, not chat transcripts. Downstream workspaces combine upstream commits. |
| How are failures and rework handled? | Each attempt uses a fresh Pi session. Failures block only affected branches. Feedback edges have explicit targets and limits; changes invalidate downstream results. |
| When is work complete? | Only after valid terminal results have been successfully published to the user's directory. Conflicts or a dirty directory preserve state rather than reporting false success. |
| What is the source of truth? | SQLite append-only events and the backend runtime. The UI displays projections and provides approval, pause, and intervention controls. |

Grapher is **not** a substitute for model quality, and not every task benefits from a graph. Single or linear tasks use Serial; unnecessary parallelism can cause conflicts. A graph makes concurrency, dependencies, feedback, and delivery boundaries explicit and inspectable instead of merely letting multiple models talk. See the [architecture document](agent.md) for technical details and invariants.

```text
Goal -> Partitioner --serial--> one task (runs in project directory)
          |
          +--graph--> Planner -> Graph IR -> Compiler -> user approval
                                                |
                                                v
                              Rust Runtime -> fresh Pi instances
                                   |          (independent Git repos)
                                   +-> merge file states -> publish to project
```

## Quick start

**Requirements:** Node.js 22.19+, stable Rust, Git, npm, working Pi provider authentication, and network access. Native execution currently targets macOS (Seatbelt) and Windows 10/11 x64 (AppContainer). Windows CI covers compilation and regression tests, but the complete publishing/isolation path still needs validation on a real Windows host. Other systems have no guarantee of safe Graph execution; failures do not fall back to unisolated execution. Pi is a pinned upstream submodule, not a globally installed replacement.

```sh
git clone --recurse-submodules https://github.com/zhexusun10/grapher.git
cd grapher
npm ci --ignore-scripts
npm run pi:setup
npm run dev
```

Open <http://127.0.0.1:1420>. The first launch may take time while Cargo compiles. For an existing clone, first run `git submodule update --init --recursive`. In Settings, select a local project directory and a `provider/model`; sign in through Provider settings or run `npm run pi` to authenticate with the upstream CLI. Do not put real secrets in `.env.example`; if you need environment variables, copy it to the Git-ignored `.env`. Pi credentials default to `~/.grapher/pi-agent` (configurable via `PI_CODING_AGENT_DIR`).

1. Enter a goal; the Partitioner routes it to Serial (one task, automatically approved) or Graph.
2. For Graph, the Planner generates a graph, the Compiler validates it, and the user reviews and approves it. Independent nodes need not be connected by edges.
3. The runtime executes nodes, combines Git states, and handles bounded feedback and conflicts. The UI supports pausing, intervention, and history inspection.
4. Graph work is complete only after successful publication; publication failures preserve state for inspection or retry.

In production mode, the local server serves the page and API at `127.0.0.1:1421`:

```sh
npm run build
npm start
```

`GRAPHER_PORT` changes the backend port; it must match when running `npm run backend` and `npm run frontend` separately. Do not treat `GRAPHER_ALLOWED_ORIGINS` as API authentication.

## Architecture and code

| Directory | Purpose |
| --- | --- |
| `backend/src/` | Rust Compiler, runtime, workspaces, Git publishing, SQLite, and local HTTP API |
| `engine/` | Pinned Pi launcher, provider/auth adapters, and Graph node path tools |
| `src/` | React UI, graph, timeline, and runtime logs |
| `backend/resources/` | Planner/Partitioner prompts and tool contracts |
| `scripts/`, `backend/tests/` | Baseline checks, fixtures, and integration regressions |
| `pi/` | Upstream Pi submodule; its documentation and license belong to upstream |

Runtime data defaults to `.grapher/` (overridable with `GRAPHER_DATA_DIR`), including SQLite, planning records, sessions, and shadow repositories. Graph workspaces live next to the project under `<project-parent>/.grapher-worktrees/`. Despite the name, each node uses an **independent Git repository**, not a worktree. Ordinary folders use external shadow Git metadata; no `.git` is created in the user's directory. See [native execution](engine/native-execution.md) for more on paths, mapping limitations, and lifecycle.

## Development and validation

```sh
npm run check                 # TypeScript
npm run build                 # UI
npm test                      # Rust fixture tests; no paid model
npm run test:pi               # pinned Pi / auth transport contract
npm run test:native           # host-native regression (platform dependent)
```

`npm run test:http`, `npm run test:benchmark`, and `npm run benchmark:planner` depend on the sibling `../grapher-tests/`, which is **not included in this repository**. A clone of this repository is enough for the basic checks above, but not for those external evaluations. `npm run test:runtime` uses the runtime host in this repository. Fixtures and model-free tests cannot establish real provider semantic quality or every sandbox boundary; release requires platform and real-model acceptance testing.

## Documentation

- [Architecture, invariants, and Graph/Serial semantics](agent.md)
- [Pi version pinning, authentication, and upgrade process](engine/README.md)
- [Native execution and path mapping](engine/native-execution.md)
- [Planner tool permissions](backend/resources/planning-inspection.md)

## License

Original Grapher code is licensed under the [MIT License](LICENSE), copyright © 2026 Sun Zhe-xu. `pi/` is a separate upstream submodule governed by its own [MIT license and copyright notice](pi/LICENSE). Third-party dependencies remain subject to their respective licenses.

**Before public release:** Confirm that all contributors and assets can be released under their respective licenses, review credentials in commit history and external artifacts, and complete real-platform security acceptance testing.
