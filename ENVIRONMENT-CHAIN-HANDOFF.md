# `test:environment-chain` failure — handoff for a macOS reproduction

> Temporary handoff note. Delete it once the bug is fixed; it is not permanent
> repository documentation.

## 中文摘要（TL;DR）

`npm run test:environment-chain` 在 CI（ubuntu-22.04 / macos-14）和本地 Windows
上都会失败：`verify` / `report` 节点没有使用 `create` 节点创建的私有 venv，
`python -c "import grapher_probe"` 退回到宿主 Python，报
`ModuleNotFoundError: No module named 'grapher_probe'`。

根本现象：**环境发现（environment discovery）观察器从未运行**，
`data/sessions/<executionId>/environment-observations/<generation>/` 目录从未创建，
因此 `create.result.environment` 是 `undefined`，venv 没有被绑定。

该失败是**既有问题**，与最近的改动无关：把 `engine/workspace-paths.mjs` 的
可见命名空间改动、以及 `engine/launch-binding.mjs` 的 env scrub 改动都还原后，
问题依旧复现。`test:environment-chain` 是 `3a8a9e4` 才加入 CI 的新步骤，之前因为
job 在前面就失败而被跳过，所以从未真正跑过。

本文件记录了复现步骤、代码路径、已排除项，以及需要在 Mac 上确认的具体检查点。

---

## 1. Symptom

CI step: **Verify default environment discovery across a Graph chain (local model)**
(`.github/workflows/planner-source.yml`) → `npm run test:environment-chain`.

TAP output (identical on `ubuntu-22.04` and `macos-14`):

```
# Subtest: default environment discovery binds one private venv across a parallel Graph and isolates new Runs
not ok 1 - default environment discovery binds one private venv across a parallel Graph and isolates new Runs
  ---
  duration_ms: 28247.152239
  type: 'test'
  location: '.../scripts/environment-chain.test.ts:68:1'
  failureType: 'testCodeFailure'
  error: |-
    AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
    + actual - expected

    + [
    +   AssertionError [ERR_ASSERTION]: native tool failed: "Traceback (most recent call last):
        File "<string>", line 1, in <module>
          import json,pathlib,sys,grapher_probe
      ModuleNotFoundError: No module named 'grapher_probe'"
    + ]
    - []
  ---
```

The assertion is `scripts/environment-chain.test.ts:92` (the local model server
rejects any tool result containing `Traceback`). With that assertion relaxed, the
test proceeds and then fails at `scripts/environment-chain.test.ts:214`:

```
TypeError: Cannot read properties of undefined (reading 'kind')
```

because `create.result.environment` is `undefined`.

## 2. Reproduction

Prerequisites (macOS): Node 22.19+, pinned Pi (`npm run pi:setup`), native
Python 3.11+ with `venv`, Git, Bash. macOS uses the built-in Seatbelt sandbox;
no extra setup is required (unlike Linux's `bubblewrap`).

```sh
npm run test:environment-chain
```

This runs `npm run pi:verify && node scripts/environment-build.mjs && node
scripts/node-ts.mjs --test scripts/environment-chain.test.ts`, where
`environment-build.mjs` builds `backend/target/debug/grapher` with
`--no-default-features`.

To iterate without the full script:

```sh
node scripts/cargo.mjs build --manifest-path backend/Cargo.toml --no-default-features --bin grapher
node scripts/node-ts.mjs --test scripts/environment-chain.test.ts
```

If a running backend locks `backend/target`, wrap the Cargo command with
`node scripts/temporary-target.mjs -- ...`.

## 3. What the test expects

Graph (`scripts/environment-chain.test.ts:167-177`):

```
left ┐
right ┴─> create ─> verify ─> report
```

- `left` / `right`: `PREP_BRANCH` — parallel, unbound.
- `create`: `CREATE_PROBE` →
  `python -m venv .venv --without-pip && source .venv/bin/activate && python -c <createProbe>`.
  `createProbe` writes `grapher_probe.py` into the venv's `purelib` and records
  `environment-probe.json`.
- Runtime must **discover** the created `.venv` and bind it to `create`'s result
  (`launchRef` with `environment.kind === 'venv'`, `environment.prefix === '.venv'`).
- `verify`: `VERIFY_PROBE` → `python -c <verifyProbe>` with **no explicit
  activation**. It must resolve `python` to `.venv/bin/python`, import
  `grapher_probe`, and assert `sys.prefix == .venv`.
- `report`: same, writing `reports/report.json`.
- `verify.input`/`report.input` must inherit `create.result.environmentRef`.

## 4. What actually happens

Backend log for the run:

```
[Execution] Started node 'left'   ... finished, errors: 0
[Execution] Started node 'right'  ... finished, errors: 0
[Execution] Started node 'create' ... finished, errors: 0
[Execution] Started node 'verify' ... finished, errors: 1   <-- tool failed
[Execution] Started node 'report' ... finished, errors: 1
```

Observed in the retained data dir:

- `data/environments/<runId>/launches/*.json` — every launch has the **unbound
  baseline PATH** (no `.venv` entry) and `environment` is absent/`undefined`.
- `data/sessions/<createExecId>/environment-observations/` — **does not exist**
  (no discovery receipts at all).
- So the venv is never bound; `verify`/`report` run the host `python`.

## 5. Pipeline — where the discovery is supposed to happen

1. **Runtime injects the observer binding** (only when `config.discovery`):
   `backend/src/environment.rs:1412-1426`
   ```
   command.env("GRAPHER_ENVIRONMENT_DISCOVERY", <context file>)
          .env("GRAPHER_ENVIRONMENT_HELPER", <current_exe>);
   ```
2. **The extension wraps the model's Bash** so each `python` / `pip` / `conda`
   invocation is observed:
   - `engine/launch-binding.mjs` → `managedBashCommand(command)` builds a
     `__grapher_env_tool` shell function **only when
     `process.env.GRAPHER_ENVIRONMENT_DISCOVERY` is set**.
   - Called from `engine/prompt-extension.ts` (`scopedOps.exec` at line ~156 and
     the `user_bash` hook at line ~140).
   - `prompt-extension.ts` is registered as the inline factory `workspacePolicy`
     in `engine/global-extensions.ts` (`executionResources` →
     `extensionFactories`).
   - `engine/execution-cli.ts:33` passes it to Pi:
     `await runPiCli(resources.args, { extensionFactories: ... })`
     (`engine/pi-compat.ts:47`).
3. **The observer writes receipts**:
   `engine/launch-binding.mjs` runs
   `GRAPHER_ENVIRONMENT_HELPER --grapher-env-tool <context> <tool> <exe> <args>`;
   `backend/src/main.rs:4` dispatches to
   `backend/src/environment_discovery.rs::tool(...)` (line 420), which writes to
   `<session>/environment-observations/<generation>/`.
4. **The binding is resolved** from those receipts:
   `environment_discovery.rs::resolve_for_policy` (line 843), read by
   `environment.rs` (`resolve_for_policy`, line ~971).
5. **Temp binding note**: `backend/src/native.rs:285` `bind_process_paths` sets
   `TMPDIR` / `TMP` / `TEMP` / `XDG_RUNTIME_DIR` to the **session directory** for
   the execution process. Any debug log written via `os.tmpdir()` from the
   engine/extension will therefore land in `data/sessions/<id>/`, not the OS temp.

## 6. What has already been ruled out

- **Not** the `createWorkspacePaths().visible()` source-alias change
  (`engine/workspace-paths.mjs`, commit `e6b062c`): the test still fails with
  that line reverted to `allWorkspaces` only.
- **Not** the `managedBashOptions` / `scrubModelShellEnvironment` env-scrub change
  (`engine/launch-binding.mjs`): the test still fails with that change reverted.
- **Not** the mask-teardown test change (that only affects `finally`, not the
  body).
- Deterministic: fails on Windows locally and on ubuntu/macos in CI.

## 7. Instrumentation used so far (re-apply to narrow further)

- Added a debug write at the top of `engine/launch-binding.mjs::managedBashCommand`
  and at module scope + inside the `bash` `execute` in `engine/prompt-extension.ts`,
  appending to `join(os.tmpdir(), 'grapher-*.log')`.
- **Neither log appeared**, which suggests the managed Bash path (and therefore
  the discovery observer) is never reached in the node process for this scenario.
- The engine copy used by the node does contain the patched files (verified in
  `engine-cache/grapher-native-engine-<uuid>/engine/…`), so the copy is not stale.

## 8. Specific asks for the macOS tester

Please run `npm run test:environment-chain` and report:

1. **Retain the temp dir**: temporarily replace the `finally` teardown in
   `scripts/environment-chain.test.ts` (around line 319-322) with
   `console.error('KEEP_DIR', directory);` and note the printed path.
2. From that directory:
   - `data/environments/<runId>/launches/*.json` → is any `environment` set? Is
     `.venv` first on `path`?
   - `data/sessions/<createExecId>/environment-observations/` → does it exist?
     any `*.json` receipts?
   - `data/sessions/<verifyExecId>/launch-<id>.json` → is `.venv` on `path`?
3. Add a temporary log to `managedBashCommand` and `prompt-extension.ts` (write
   to `process.cwd()` or the session dir, **not** `os.tmpdir()` assumptions) and
   report whether they run at all for a node.
4. Confirm whether `prompt-extension.ts` is loaded in the node's
   `execution-cli.ts` process, and whether Pi 1.4.0 honours `extensionFactories`
   passed to `runPiCli`. **If the inline `workspacePolicy` factory is dropped, the
   managed Bash path never activates for nodes — which matches the symptoms.**
5. In the `verify` node, print the resolved interpreter
   (`which python` / `sys.executable`) to confirm it is the host Python.

## 9. Useful commands

```sh
# The failing suite
npm run test:environment-chain

# The sibling suite (passes now; useful as a working comparison)
npm run test:environment

# Rust-side environment library tests
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --lib environment -- --test-threads=1

# Planner Bash contract (passes; exercises the managed Bash path for the Planner)
npm run test:planner-bash
```

## 10. Constraints (from `AGENTS.md`)

- Do not bulk-scan or edit `pi/`; never hand-edit `pi-lock.json`, `model-data/`,
  or `pi-dependencies/`.
- Always invoke Cargo via `node scripts/cargo.mjs`.
- Use `node scripts/temporary-target.mjs -- <cargo args>` if a running backend
  locks build artifacts; do not stop the backend or clean its cache.
- Verify with the targeted check only; do not run the full aggregated suites.
