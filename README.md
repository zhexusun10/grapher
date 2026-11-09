<p align="center">
  <img src="assets/icon-dots.svg" width="80" height="80" alt="Grapher logo">
</p>

<h1 align="center">Grapher</h1>

<p align="center">
  <strong>Don't orchestrate agents. Compile work.</strong><br>
  No more “lost in translation”.
</p>

<p align="center">
  A local coding-agent workbench that turns complex work into inspectable execution graphs.<br>
  Built on <a href="https://github.com/earendil-works/pi">Pi</a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="docs/user-guide.md">User guide</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/zhexusun10/grapher/actions/workflows/planner-source.yml"><img src="https://github.com/zhexusun10/grapher/actions/workflows/planner-source.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <a href="https://www.rust-lang.org/"><img src="https://img.shields.io/badge/rust-stable-orange.svg" alt="Rust stable"></a>
</p>

<p align="center">
  <img src="assets/readme-graph.png" width="100%" alt="Grapher workbench showing a 21-node video detection research plan awaiting approval">
  <br><sub>From a complex goal to an inspectable 21-node execution graph with parallel branches and bounded feedback.</sub>
</p>

## Typical multi-agent systems vs Grapher

```text
Typical multi-agent systems

Goal → Supervisor LLM → Agent → Supervisor LLM → Agent → ...
             ↑ scheduling lives inside the conversation loop


Grapher

Goal → Planner → Compiled Graph → Deterministic Runtime
                                      ├── Agent A ──┐
                                      ├── Agent B ──┼──→ Agent D
                                      └── Agent C ──┘
```

**Core differences:**

1. **No supervisor in the execution loop** — The LLM plans the graph, then gets out of the scheduler.
2. **Never lost in translation (Zero conversational message passing)** — Traditional multi-agent systems rely on endless agent-to-agent chatter where requirements and constraints degrade like a game of telephone. In Grapher, nodes never exchange chat messages; parallel tasks inherit verifiable Git code states and history, not conversations.
3. **The graph is executable state** — Dependencies, retries, feedback, and publication are explicit runtime transitions.
4. **No predefined agent roles** — All nodes run general-purpose coding agents; specialization comes from task context, not hardcoded roles.

## Why Grapher?

- **Integrated coding-agent workbench** — Chat with coding agents, manage provider authentication and per-role model settings, inspect tool calls, logs, and file diffs, and intervene from the same UI.
- **Deterministic orchestration** — Scheduling, dependencies, invalidation, retries, and bounded feedback are explicit Rust state transitions. We don't introduce prior bias to the model; keep it flexible and general-purpose by decoupling model usage from system orchestration: deterministic and systemic rules belong to the runtime/harness, not to prompts that expose system details.
- **Workspace inheritance (Code, not chat)** — Children inherit parent Git history and its complete project-file state, including files matched by `.gitignore`. Nothing is lost in translation across inter-agent dialogue because agents never chat with each other: conversations stay strictly within their own nodes, while code flows through verified Git snapshots. Linear work can hand off a Git working tree; fan-out branches use independent Git worktrees; Git handles conflicts and publication.
- **Inspectable execution graph & loop engineering** — Review and approve the graph before execution; see dependencies, parallel branches, and bounded rework in the UI, or enable post-task Planner review for autonomous multi-turn iteration.
- **Local-first** — Run on your machine and publish valid Graph results back to your codebase before declaring completion. Model requests still go to your configured provider.

<details>
<summary><strong>See a completed 16-node run in the earlier UI</strong></summary>
<p align="center">
  <img src="assets/execution-graph.png" width="100%" alt="Earlier Grapher interface showing a machine-learning run marked 16 of 16 nodes completed">
  <br><sub>Actual Grapher UI showing a 16-node execution graph compiled and executed for a multi-stage machine-learning task.</sub>
</p>
</details>

## When should I use Grapher?

<p align="center">
  <img src="assets/readme-home.png" width="100%" alt="Grapher's home screen with a video detection research goal and Auto, Serial, and Graph mode controls">
  <br><sub>Start with a goal, then choose the route that fits the work: Auto, Serial, or Graph.</sub>
</p>

**More agents are not always better.** Grapher works best when a coding task contains independent workstreams, for example:

- Frontend + backend changes
- Implementation + tests
- Machine-learning and research pipelines with independent feature, training, and evaluation modules
- Implementation followed by bounded review/rework

For small, linear, or tightly coupled tasks, use **Serial** instead. Use **Graph** when explicit dependencies and independent workstreams justify it; **Auto** lets the Partitioner choose.

| | Serial | Graph |
| --- | --- | --- |
| Best for | Small / linear tasks | Independent workstreams |
| Coding agents | One | One or more task nodes |
| Planning | Direct | Compiled execution graph |
| Approval | Automatic | User approval by default |
| Workspace | Your project | Private Run workspaces with state inheritance and exclusive handoff |
| Scheduling | Sequential | Dependency-aware, bounded parallelism |

See the [user guide](docs/user-guide.md) for planning side effects, controls and recovery. Graph is a route, not a minimum agent count; it can contain a single node.

## Quick start

**Requirements:** Node.js 22.19+, stable Rust, Git, npm, network access, and provider authentication. Windows needs Git for Windows Bash; macOS needs Xcode Command Line Tools for the Rust linker and uses the built-in Seatbelt sandbox for Graph; Linux Graph needs bubblewrap and permitted unprivileged user/mount/PID namespaces.

**No build tools?** Download a ready-to-run [release archive](https://github.com/zhexusun10/grapher/releases/latest) instead: verify its `.sha256` checksum, extract it, and run `start.bat` (Windows) or `./start.sh` (macOS/Linux). Archives still require Node.js 22.19+ and Git at runtime; Rust and npm are not needed.

```sh
git clone --recurse-submodules https://github.com/zhexusun10/grapher.git
cd grapher
npm run dev
```

`npm run dev` automatically checks prerequisites, initializes submodules, installs locked dependencies, and builds the backend. For manual or step-by-step setup, you can also run `npm ci --ignore-scripts` followed by `npm run pi:setup`.

Open **<http://127.0.0.1:1420>**. The first launch may take time while Cargo compiles. On macOS, the backend keeps the display and system awake while it runs, so long tasks are not interrupted by idle sleep or the screen-saver lock; set `GRAPHER_KEEP_AWAKE=0` to disable this.

1. In **Settings**, select a local project, authenticate a provider, and choose a `provider/model`. You can also sign in through `npm run pi`.
2. Enter a coding goal. Choose **Serial** for a single Pi agent, **Graph** for a task graph, or **Auto** to let the Partitioner select the route.
3. For Graph, inspect and **approve** the plan. Follow node logs, pause running nodes and later continue their sessions, or send instructions.
4. Graph work is complete only after valid results are published to your project. Publication failures preserve state for inspection or retry.

**Use trusted projects; start with a disposable one.** Planner Bash writes directly to the source before approval, even if planning fails or is cancelled; snapshots force-collect project files into Git except Runtime/managed-environment internals. Reject is not rollback. Windows workspaces are not filesystem sandboxes. Read [Before you approve](docs/user-guide.md#before-you-approve) and the [filesystem boundaries](docs/architecture/filesystem-isolation.md) before important work.

For an existing clone, first run `git submodule update --init --recursive`. Pi is pinned; a global Pi installation is not substituted.

For local production mode:

```sh
npm run build
npm start
```

Open <http://127.0.0.1:1421>.

## Project status

**Working:**
- Serial coding-agent workflow
- Graph planning and approval
- Dependency-aware execution
- Workspace inheritance
- Bounded feedback edges
- Result publication
- Post-task Planner review and autonomous loop engineering
- Linux sandbox (bubblewrap)
- Release archives (Windows/macOS/Linux) and one-command dev setup

**Still evolving:**
- Cross-platform isolation (Windows sandboxing)
- Routing quality and graph compilation heuristics
- Provider compatibility coverage
- Performance optimization

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
                                  |               |
                               Agent A         Agent B
                                  \               /
                                  Workspace inheritance
                                           |
                                           v
                                        Agent C
                                           |
                                           v
                                  Publish to project
```

Models decide how to split the work and perform each task. The compiler validates the graph. After compilation, the planner can stop: scheduling no longer depends on a coordinator's next message. Ordinary dependencies form a DAG: a child runs after its parents complete and inherits parent Git history plus the complete project-file state, including paths matched by `.gitignore`. Applied feedback sends bounded rework instructions and hands the sender's completed workspace to a fixed target, which continues its own conversation. All project outputs are Git commits; conversations are never exchanged between nodes, ensuring technical intent and codebase reality are never lost in translation.

When enabled, **Post-task Planner review** invokes the Planner once all nodes finish and valid changes are published to the project. The Planner inspects the updated workspace and decides the next step—auditing results, formulating a follow-up plan, reporting to the user, or completing wrap-up work—without violating node isolation (Git workspace inheritance with zero node-to-node messaging). Paired with **Auto Approve**, this supports robust, multi-turn loop engineering.

## Architecture

**Models do the coding; the runtime owns the workflow.** Grapher keeps dependencies, bounded rework and delivery explicit instead of delegating scheduling to another conversation. You can inspect the plan, intervene during execution and verify that the result reached your project.

For everyday operation, read the [user guide](docs/user-guide.md). Building or changing Grapher? Start with [developer architecture](docs/architecture/overview.md) for component boundaries and canonical contracts.

## Development

```sh
npm run check
npm run build
npm run test:frontend
npm run test:backend          # Rust fixtures; no paid model
```

See [Contributing](CONTRIBUTING.md) and the [testing guide](docs/development/testing.md) for integration/platform checks and log acceptance. Report vulnerabilities through the [security policy](SECURITY.md). Model-free tests do not establish provider quality or every sandbox boundary.

## Documentation

**Using Grapher:** [User guide](docs/user-guide.md) · [Security policy](SECURITY.md).

**Developing Grapher:** [Architecture contracts](docs/architecture/overview.md) · [Contributing guide](CONTRIBUTING.md) · [Benchmarks](docs/benchmarks/harbor.md).

The [documentation index](docs/index.md) separates user guidance from developer task routes. Coding agents should use [AGENTS.md](AGENTS.md) for repository constraints.

## License

Original Grapher code is licensed under the [MIT License](LICENSE), copyright © 2026 Sun Zhe-xu. The upstream `pi/` submodule has its own [MIT license and copyright notice](pi/LICENSE). Third-party dependencies retain their respective licenses.
