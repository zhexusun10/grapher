# Harbor evaluation adapter

Grapher provides a Harbor **custom installed agent** at `benchmark.harbor_agent:GrapherAgent`. Harbor and its datasets are installed separately; this repository does not bundle a benchmark host or claim an aggregate score.

The integration baseline is Harbor **0.23.0**, with the interface pinned in [Linux CI](../../.github/workflows/linux-native.yml) to commit `31668af15560fb50a9d0584816d12726036656cf`. Other Harbor versions need interface verification.

## Linux task environment

Prepare Grapher **inside each task environment**, not only on the Harbor host. The default installation is `/installed-agent/grapher` and must include:

- Executable `backend/target/release/grapher` built from the same clean, pinned checkout.
- Grapher `engine/` and `scripts/`, the pinned `pi/` submodule, and installed/built Pi dependencies.
- Node.js 22.19+, Git, Python 3, and bubblewrap at `/usr/bin/bwrap`.
- A task working directory equal to the project root and network access for the chosen provider.

Graph uses bubblewrap inside the task container. The outer container must permit unprivileged user/mount/PID namespaces and required bind/proc mounts. The adapter and Graph preflight run a real namespace probe, including `/dev/null` read/write. Failure stops execution; the adapter does not force Serial or use fixtures to bypass isolation.

The node's private repository/session is exposed while source/sibling/data paths are masked and engine/install paths are read-only. The outer container itself is not the per-node boundary. See [Filesystem isolation](../architecture/filesystem-isolation.md).

[benchmark/tb4-compose.yaml](../../benchmark/tb4-compose.yaml) is a specialized local nested-namespace overlay, not a general multi-tenant security recommendation. Evaluate its privileges against your environment before use.

## Build a pinned installation

From the repository root:

```sh
docker build -f benchmark/Dockerfile \
  --build-arg GRAPHER_COMMIT=<full-pinned-grapher-sha> \
  -t grapher-harbor:<sha> benchmark
```

[The Dockerfile](../../benchmark/Dockerfile) fetches a fixed commit rather than copying local `.env`, credentials, or uncommitted files. It supplies a base installation, **not a replacement for a task's dependencies/files**. Build task images from it without losing the original task environment; comparisons must offer each agent equivalent tools and permissions.

Alternatively, build a pinned recursive checkout during task-image preparation, run `npm run pi:setup`, and build the production Rust binary. Git must support `--path-format=absolute`; a compiler toolchain is needed for building, not necessarily for every timed trial.

Installation verifies bwrap, pinned Pi, checkout cleanliness, and binary `--build-identity` matching `git rev-parse HEAD`. It records that commit as the agent version. Do not download/compile Grapher during the timed trial. A non-root task user needs suitable read/access permissions and a trusted Git checkout.

## Run through Harbor

Ensure the Harbor host can import the adapter using `PYTHONPATH`. From the Grapher repository root, with Harbor installed separately:

```sh
PYTHONPATH="$PWD${PYTHONPATH:+:$PYTHONPATH}" harbor run \
  -p /path/to/harbor/tasks \
  -a benchmark.harbor_agent:GrapherAgent \
  -m anthropic/claude-sonnet-4-5 \
  --agent-env ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  --ak thinking=medium --ak max_parallel=4 --ak timeout_sec=28800
```

Replace the provider/model and credential variable with a supported pinned-Pi configuration. Protect shell/host logs containing authentication inputs; prefer Harbor's model-connection credential forwarding where appropriate. Configure the outer Harbor timeout above the runner budget, leaving time for setup, shutdown, and trace synchronization.

Custom provider endpoints/auth must be explicitly passed through Harbor's environment/model connection. Benchmark mode isolates Pi configuration and does not silently inherit the host's `models.json` or installation `.env`. A new unsupported provider is not made supported merely by an environment variable.

## Adapter options

| `--ak` option | Default / meaning |
| --- | --- |
| `grapher_root` | `/installed-agent/grapher`; absolute path inside the task environment |
| `thinking` | `medium`; role thinking level |
| `max_parallel` | `4`; per-Graph-Run limit, 1–8 |
| `timeout_sec` | `28800`; end-to-end Grapher trial budget in seconds |
| `bootstrap_debian_tools` | `false`; opt-in setup-time installation of missing Git/Python/bwrap, requiring root and apt-get |

Agent version is derived from the verified binary, not a user-supplied `version` option.

## Routing, approval, and terminal state

Each trial starts a private loopback backend, runtime data directory, and Pi configuration directory. The original task instruction is passed to `plan_goal` **without a forced mode**; the Partitioner chooses Serial or Graph.

Evaluation sets `autoApprove=true`, including compiler-validated Planner graphs. All roles use Harbor's selected model; hidden role-model overrides are not allowed. Serial must finish its task; Graph must finish valid nodes **and publish** to the task directory. Failures, stalls, cancellation, and timeouts do not become successful terminal states.

Harbor's original task verifier decides the score. The adapter does not write verifier files or read expected answers. Stopping the trial terminates the backend/children; Linux also uses a parent-death signal to reduce delayed writes after forced runner termination.

## Logs and evidence

The trial's agent-log directory retains:

| Artifact | Content |
| --- | --- |
| `backend.log` | Backend stdout/stderr |
| `snapshot.json` | Final or last available Snapshot |
| `result.json` | Run identity, route, model, metrics or failure reason |
| `trace/` | Planning attempts/Pi sessions, node sessions, Merger output, consistent post-stop SQLite backup |
| `trace-manifest.json` | Retained file sizes and SHA-256 checksums |

Shadow Git, Pi auth directories, and symlinks are not copied into the trace archive. Logs may still contain private code, prompts, tool output, or secrets echoed by a task; treat them as sensitive. Ensure Harbor `include_logs`/`exclude_logs` does not omit required evidence. Trace archival failure fails the trial.

Provider token usage maps to Harbor's AgentContext, including cache accounting; costs are not invented. Avoid tiny environment values such as `NODE_TLS_REJECT_UNAUTHORIZED=0` in `--agent-env`: global value-based redaction can corrupt JSON digits in logs. For local mock TLS tests, use a test CA through `NODE_EXTRA_CA_CERTS` instead.

## Comparable evaluation

Record and align:

- Grapher/Pi/Harbor commits and adapter/tool hashes.
- Dataset version and the **actual task digests in the Harbor job lock**.
- Image architecture, task dependencies/tools, namespace policy, and mount permissions.
- Provider/model **and endpoint**, thinking, credential permissions, budget, concurrency, attempts, and retry policy.
- Every trial's terminal state, verifier result, trace integrity, and environment failures.

Do not exclude platform failures then label the remaining subset a full score. Git-tag task hashes may differ from a published Harbor Hub package; do not substitute them for the job's locked digests. One task, a protocol mock, or successful installation is not an aggregate quality result.

### Terminal-Bench helper

[benchmark/tb4.py](../../benchmark/tb4.py) is a specialized single-user macOS/Colima ARM64 launcher, with fixed checkout/model/path assumptions and private credentials read from the local Pi directory. It is not a portable quick start. Inspect and provision its exact prerequisites before using `python3.12 -m benchmark.tb4 smoke` or `all`; use the general Harbor example for other environments.

The helper retains invocation provenance and checks smoke-trial artifacts before full evaluation. Its task budget is 28800 seconds; runs with different budgets are not equivalent. Native ARM64 task-image builds and required nested namespace permissions affect comparability. No machine-specific historical result directory or prior mock reward is presented here as a current score.

## Adapter tests

```sh
python3 -m unittest discover -s benchmark -p 'test_*.py'
```

Without a separate Harbor installation, the import-path interface test is skipped. Passing adapter unit tests does not prove the real Linux task container, model, publication, or verifier chain; validate those in the actual target environment.

Implementation: [harbor_agent.py](../../benchmark/harbor_agent.py) · [run.py](../../benchmark/run.py)
