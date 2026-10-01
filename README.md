# Grapher

> **Don't orchestrate agents. Compile work.**
>
> 不编排智能体，编译工作。

Grapher is a **local multi-agent coding system** that turns complex coding tasks into inspectable execution graphs and runs them with a deterministic Rust runtime. Independent coding agents work in parallel and combine their changes through Git—not a supervisor agent's ongoing conversation.

[Quick start](#quick-start) · [How it works](#how-it-works) · [Architecture](docs/architecture/overview.md) · [简体中文](README.zh-CN.md)

![Grapher UI showing parallel frontend and backend tasks, integration, and a bounded review feedback edge before approval](assets/execution-graph.png)

*Actual Grapher UI with a demo graph awaiting approval. Fixture data, not a live-model run or benchmark.*

## Why Grapher?

- **Deterministic orchestration** — Scheduling, dependencies, retries, and feedback are explicit Rust state transitions, not hidden in LLM conversations.
- **Git-native collaboration** — Agents exchange file states and commits, not each other's chat histories. Graph nodes use independent Git repositories.
- **Inspectable execution graph** — Review and approve the graph before execution; see dependencies, parallel branches, and bounded rework in the UI.
- **Local-first** — Run on your machine and publish valid Graph results back to your codebase before declaring completion. Model requests still go to your configured provider.

## Quick start

**Requirements:** Node.js 22.19+, stable Rust, Git, npm, network access, and provider authentication. Windows needs Git for Windows Bash; Linux Graph needs bubblewrap and permitted unprivileged user/mount/PID namespaces. See [Installation](docs/guides/installation.md) for host prerequisites and troubleshooting.

```sh
git clone --recurse-submodules https://github.com/zhexusun10/grapher.git
cd grapher
npm ci --ignore-scripts
npm run pi:setup
npm run dev
```

Open **<http://127.0.0.1:1420>**. The first launch may take time while Cargo compiles.

1. In **Settings**, select a local project, authenticate a provider, and choose a `provider/model`. You can also sign in through `npm run pi`; see [Providers](docs/guides/providers.md).
2. Enter a coding goal. Simple or linear work uses one Serial agent; independent workstreams can use Graph.
3. For Graph, inspect and **approve** the plan. Follow node logs, pause new dispatches, or send instructions.
4. Graph work is complete only after valid results are published to your project. Publication failures preserve state for inspection or retry.

**Use trusted projects; start with a disposable one.** Successful planning can merge Planner changes into the source before approval, and snapshots can stage/commit existing non-ignored changes. Reject is not rollback. Windows workspaces are not filesystem sandboxes. Read the [execution model](docs/architecture/execution-model.md) and [filesystem boundaries](docs/architecture/filesystem-isolation.md) before important work.

For an existing clone, first run `git submodule update --init --recursive`. Pi is pinned; a global Pi installation is not substituted.

For local production mode:

```sh
npm run build
npm start
```

Open <http://127.0.0.1:1421>. Configuration, credentials, data paths, and startup issues are covered in the [installation guide](docs/guides/installation.md).

## How it works

```text
Coding goal
    |
    v
Partitioner
    |-- Simple / linear task --> Serial agent --> User's project
    |
    '-- Independent workstreams
                |
                v
             Planner
                |
                v
       Execution graph --> Compiler --> User approval
                                           |
                                           v
                              Deterministic Rust runtime
                                  |      |      |
                               Agent A Agent B Agent C
                                  '--- Git state ---'
                                           |
                                           v
                                  Publish to project
```

Models decide how to split the work and perform each task. The compiler validates the graph. After compilation, the planner can stop: scheduling no longer depends on a coordinator's next message. Ordinary dependencies form a DAG; explicit feedback edges define bounded revision paths.

## Unlike conversational multi-agent systems

Conversation-driven orchestration keeps an LLM coordinator in the execution loop:

```text
Agent -> Coordinator -> Agent -> Coordinator -> ...
```

Grapher compiles the collaboration structure first:

```text
Goal -> Graph -> Deterministic runtime -> Agents -> Git -> Result
```

Inspectable scheduling does **not** make model outputs deterministic or guarantee better code. Single or linear work stays Serial; unnecessary parallelism can create conflicts.

## Architecture

The Rust backend and SQLite event log own runtime state; the React UI displays projections. Graph nodes use independent Git repositories, and delivery requires successful publication—not merely finished model calls.

Read [Architecture](docs/architecture/overview.md) for motivation and invariants, or [Execution model](docs/architecture/execution-model.md) for planning, sessions, Git state, and publication semantics. Low-level runtime, isolation, and Pi contracts are linked from those pages rather than duplicated here.

## Development

```sh
npm run check
npm run build
npm run check:docs
npm run test:frontend
npm test                      # Rust fixtures; no paid model
```

See the [development guide](docs/development/contributing.md) and [testing guide](docs/development/testing.md) for integration/platform checks and log acceptance. Model-free tests do not establish provider quality or every sandbox boundary.

## Documentation

- [Architecture](docs/architecture/overview.md)
- [Execution model](docs/architecture/execution-model.md)
- [Installation & providers](docs/guides/installation.md)
- [Development guide](docs/development/contributing.md)
- [Benchmarks](docs/benchmarks/harbor.md)

## License

Original Grapher code is licensed under the [MIT License](LICENSE), copyright © 2026 Sun Zhe-xu. The upstream `pi/` submodule has its own [MIT license and copyright notice](pi/LICENSE). Third-party dependencies retain their respective licenses.
