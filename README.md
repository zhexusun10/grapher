# Grapher

Don't orchestrate agents. Compile work.

基于 [`agent.md`](agent.md) 的本地 Agent Runtime：**浏览器 React/TypeScript + React Flow 前端，终端 Rust + SQLite 后端**。前端通过 HTTP 调用后端；编译、规划、执行和历史记录均以 Rust 状态为准。

## 启动

需要 Node.js 22.19+、Rust stable、Git 和支持 POSIX 进程的环境。真实模型执行还需要 Pi CLI。

```sh
npm ci --ignore-scripts
export PATH="$HOME/.cargo/bin:$PATH"
npm run dev
```

在浏览器打开 **http://127.0.0.1:1420**。该命令同时启动前端开发服务器和后端，按 Ctrl+C 一起停止。首次启动需要等待 Cargo 构建完成。

也可以在两个终端分别运行：

```sh
# 终端一：后端
npm run backend

# 终端二：浏览器前端
npm run frontend
```

后端默认监听 `127.0.0.1:1421`，前端开发服务器将 `/api` 转发到后端。设置 `GRAPHER_PORT` 可更改后端端口；分开启动时两个终端须使用相同值。服务仅用于本机访问。

生产模式不需要前端开发服务器：

```sh
npm run build
npm start
```

打开 **http://127.0.0.1:1421**，Rust 后端同时提供构建后的网页和 API。关闭网页不会终止后端任务；在终端按 Ctrl+C 退出后端会记录暂停并清理受管理的 Pi 进程。

点击添加工作区后，输入**后端机器上的 Git 仓库绝对路径**。浏览器不使用原生文件选择器。后端不可用时界面显示连接错误，不会转为模拟执行。

### 真实 Pi

出货构建只有 **Pi** 一种执行引擎。先在 Pi 自己的 CLI 中完成登录和模型配置。Grapher 不收集、存储 API Key。

1. 运行设置中填写**已有 commit 且完全干净**的 Git 仓库根路径。
2. 配置 Pi 可执行文件的绝对路径；启动参数是 JSON 字符串数组，不经 shell 拼接。模型留空使用 Pi 默认值。
3. 本机若存在 `pi/` 源码和 `pi/node_modules`，开发版会预填本地 Node/tsx 启动参数。`pi/` 保持独立且不会修改；分发到其他机器需自行安装兼容 Pi。
4. 点击「规划并编译」：Partitioner 只有 `route_task`；Graph Planner 只有 `node / edge / read / bash`。每次 mutation 都调用同一个 Rust 编译器，失败不会写入候选图。Serial 路由不调用 Planner，用单节点承载原始任务，同样保留审批边界。
5. Planner 退出，完整图展示后才能审批启动工作节点。也可以直接导入手写 Graph IR，省去规划模型调用。

**安全边界：**规划会调用模型并消耗额度；执行 Pi 可以运行 shell、联网、读写其进程权限允许的文件。Worktree 是并行隔离机制，**不是安全沙箱**。仅对可信代码和任务使用真实 Pi。Planner 的 Bash 只允许固定只读命令，read 限于仓库；但 Pi 本身及仓库配置仍须可信。

## 已实现

- Graph IR 以 `name` 为语义标识，边以 `(from, to)` 唯一标识。显式 `feedback` 不可省略。
- 确定性编译：重复名称、空 task、未知节点、自环、重复边、普通依赖环、反馈祖先关系校验；执行层/根/终点和孤立节点警告。
- 强制审批；每次 execution 使用新的会话 ID 和 detached Git worktree；最大并发可设置为 1–8。
- 并行分支在下游执行前通过 Git merge 组合；变更在 worktree 内自动提交，不自动合入原仓库。
- 精确解析最终一行 `<ACCEPT>` / `<REVISE>`；协议错误显式失败；默认最多 3 次自动反馈重试；失败只阻塞依赖分支。
- SQLite append-only 事件日志与 reducer；执行流、工具调用、输出、工作区 SHA、节点 revision、介入指令和历史尝试持久化。
- 暂停停止派发**下一执行波次**，不强杀正在工作的 Pi；等待当前波次完成后可介入或重跑。所有受影响后继失效，无关分支保留。
- 退出时终止受管理 Pi 进程组；重启后端不会自动续跑。被中断的 execution 标记 failed，需人工检查并重跑 fresh session。

## 合并冲突与取回结果

合并冲突使下游节点变成 **BLOCKED**。点击该节点，从 Workspace 信息取得冲突 worktree 路径，在外部终端解决冲突并提交；暂停且等待当前波次结束后，点击 **Use resolved workspace**。运行时以解决后的快照重新启动该节点，不伪造任务成功。

代码结果保留在每个 execution 的 worktree 中，最终终点的 `After` SHA 是对应结果快照。用户自行 review，并按需要 merge/cherry-pick。多个独立终点不会自动再合并成一个提交。

持久化数据默认位于项目的 `.grapher/`。可通过 `GRAPHER_DATA_DIR` 指定已有数据目录或其他绝对路径：

```text
.grapher/
  events.sqlite
  planning/<planning-id>/
  worktrees/<run-id>/<node>-<execution-id>/
  worktrees/<run-id>/sessions-<execution-id>/
```

历史记录含源码片段和工具输出，应按本地敏感开发数据管理。

## 验证与打包

```sh
export PATH="$HOME/.cargo/bin:$PATH"
npm run build
npm test
cargo check --manifest-path backend/Cargo.toml
cargo build --release --manifest-path backend/Cargo.toml
```

核心测试不调用真实模型，覆盖编译、审批、反馈、失败传播、介入、SQLite replay、重启恢复、实际并行 worktree 合并和冲突；Pi JSON 进程协议使用本地假进程测试。测试用的确定性执行器位于 Cargo `fixture` 特性下（`backend/src/fixture.rs`），出货构建不包含它，也只接受 `pi` 引擎。

有本地 `pi/` 源码时，还可以验证真实 Pi 扩展加载和 mutation 回滚（不调用模型）：

```sh
cargo build --manifest-path backend/Cargo.toml --no-default-features
node pi/node_modules/tsx/dist/cli.mjs --tsconfig pi/tsconfig.json scripts/check-pi-extension.ts
```

## MVP 明确限制

- 仅一个活动 Graph，波次式并行调度；执行中修改节点需先暂停并等待波次结束。
- Graph 编辑使用 JSON；没有拖线编辑、自动布局库、完整 xterm 交互终端或多项目管理。
- 暂不自动清理 worktree、自动合入用户分支、安装依赖或迁移未提交改动；历史工作区按需由用户清理。
- 不支持多引擎、远程执行、自动恢复旧 Pi session、自动解决 merge conflict、签名/公证/安装更新器。
- 普通退出会清理 Pi 进程组。系统断电或后端被 SIGKILL 时不能保证清理；重启会失效未完成尝试，用户需检查残留进程和工作区。
- 支持当前本地 Pi 0.85.1 的 JSON 事件格式及 `--session-id`。真实模型认证/质量需使用用户自己的环境验证。
- Partitioner/Planner prompt 为实验性实现，不把它们当成架构不变量。

## MVP 系统 benchmark

```sh
npm run benchmark                 # 9 个确定性场景 + 1 个真实 Pi 文件任务
npm run benchmark:validate        # 连续 3 次确定性套件 + 3 次真实规划执行样本
npm run benchmark -- --deterministic  # 无模型成本
```

确定性场景通过 `benchmark` Cargo 特性启用 `fixture` 执行器：只有「节点执行」这一步是确定性的，编译器、调度器、真实 Git worktree、SQLite 事件日志与反馈失效全部走出货代码路径。

结果保存在 `benchmark-results/<run-id>/`，包含 summary/cases/events、API 请求响应、SQLite、worktree 和会话日志。真实 Pi 需要现有模型认证和联网；网络错误保持 FAIL 并单独分类。可用 `BENCHMARK_PI_COMMAND`、`BENCHMARK_PI_ARGS`（JSON 数组）、`BENCHMARK_PI_MODEL` 指定环境。系统边界、覆盖限制与失败修复记录见 [system-under-test](benchmark/system-under-test.md)、[harness architecture](benchmark/architecture.md)、[findings](benchmark/findings.md)。

历史 benchmark 报告记录迁移前的结果，不代表当前 HTTP 实现的验证结果。当前适配器调用产品 dispatcher；HTTP 传输另由 `npm run test:http` 覆盖。
