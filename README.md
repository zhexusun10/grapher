# Grapher

Don't orchestrate agents. Compile work.

基于 [`agent.md`](agent.md) 的本地 Agent Runtime：**浏览器 React/TypeScript + React Flow 前端，终端 Rust + SQLite 后端**。前端通过 HTTP 调用后端；编译、规划、执行和历史记录均以 Rust 状态为准。

## 启动

需要 Node.js 22.19+、Rust stable、Git 和支持 POSIX 进程的环境。Pi 作为锁定 commit 的 submodule 提供，详见 [Execution Instance Engine 基线与同步流程](engine/README.md)。

```sh
git submodule update --init --recursive
npm ci --ignore-scripts
npm run pi:setup
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

出货构建以 **Pi** 为唯一 **Execution Instance Engine**，一次实际执行称为 **Execution Instance**。设置中的模型与 Provider 认证通过 Adapter 委托 Pi `ModelRuntime`；也可用 `npm run pi` 使用原生 CLI 登录。Grapher 不自行实现 provider、OAuth 或凭据刷新。

1. 运行设置中填写项目目录。标准 Git 仓库要求已有 commit 且工作树干净；普通文件夹通过外置 shadow repository 保存基线、执行和自动回写，用户目录不创建 `.git`。
2. 选择模型（可用 `provider/model` 指定 provider）。生产后端固定使用 `engine/entrypoint.mjs`；旧配置中的可执行文件和参数不再控制生产启动。
3. 先执行 `npm run pi:setup` 安装锁定依赖及恢复固定模型目录。不能用全局安装的 Pi 替代 submodule。当前 upstream 完整构建有已记录的类型检查阻塞，源码 CLI 可启动；详见基线文档。
4. Partitioner 是无工具的极简单轮文本分类器，直接输出 `graph` 或 `serial`：仅当存在多个可独立推进的实质工作流时选择 Graph，否则选择 Serial；不解决或规划任务。后端采用鲁棒关键词提取判定分支，即使模型输出多余解释或未严格遵守单词要求，只要检测到对应词即转入相应分支，成功响应但文本含糊时兜底为 Serial；启动、认证或请求失败则显式报错，不创建或自动审批执行图。Serial 跳过 Planner，后端创建名为 `task` 的单节点图并自动审批、开始执行，直接修改用户目录。各角色（Partitioner / Planner / Subagent / Merger）在统一的 `PiModelConfig` API 层解析模型与思考预算（支持 `PARTITIONER_MODEL`、`PLANNER_MODEL`、`SUBAGENT_MODEL`、`MERGER_MODEL` 覆盖）。
5. Graph Planner 使用 `node / edge / read / bash` 生成完整可执行图。每次 mutation 调用 Rust 编译器，校验失败不会写入候选图；Planner 退出后展示图，用户批准才启动节点。也可以导入手写 Graph IR。

### 角色环境隔离与 Subagent 技能/插件支持

1. **环境与模型隔离（解耦与防泄漏）**：
   - 各角色拥有专属配置环境变量：`PARTITIONER_MODEL` / `PARTITIONER_THINKING`、`PLANNER_MODEL` / `PLANNER_THINKING`、`SUBAGENT_MODEL` / `SUBAGENT_THINKING`、`MERGER_MODEL` / `MERGER_THINKING`，超时通过对应 `*_TIMEOUT_SECONDS` 配置。
   - 子进程环境净化：每次调用 Pi 启动子进程前，后端显式调用 `env_remove` 剔除父环境中的 `PI_MODEL`、`PI_THINKING`、`PI_PROVIDER`、`PI_REASONING_LEVEL`、`PI_SESSION_ID`、`PI_SESSION_FILE`，避免终端或外部 Pi 会话残留污染内部子进程。
   - 命令行显式指定 `--model <resolved_model>` 覆盖外部 `~/.pi/agent/settings.json` 的 `defaultModel`。
2. **角色权限分流与扩展加载**：
   - **Partitioner / Planner / Merger**：始终附带 `--no-extensions`、`--no-skills` 与 `--no-approve`，防止未知的外部 Prompt / Tool / 扩展破坏图规划、分类决策或冲突解决的确定性与纯粹性。
   - **Subagent（执行代码的 Worker 实例）**：
     - 解除 `--no-skills` 与 `--no-extensions`，附带 `--approve` 显式信任工作区，支持加载全局（如 `~/.agents/skills/`、`~/.pi/agent/skills/`）与当前工作区（如 `.agents/skills/`、`.pi/skills/`）的 Skill 以及插件配置（`~/.pi/agent/extensions/`、`settings.json` packages）。
     - 工具链采用开放策略（不传递硬编码 `--tools` 白名单限制），确保 Extension 注册的自定义工具（Extension Tools）与内置基础工具（`read, write, bash, edit`）同时生效。
     - **多节点沙箱与 Worktree 隔离注意**：在 Graph 多节点并发模式下，Worker 运行于独立的 `.grapher-worktrees/<run>/<instance>` 沙箱中（严格隔离主仓库路径）。因此，**工作区级的 Skill 与 Extension 必须已提交（commit）到 Git 仓库**，独立 Worktree 检出时才能包含对应文件；未跟踪的本地文件在 Graph 模式下沙箱不可见（Serial 单节点模式直接在主工作区执行，不受此限制）。


### 当前 Planner

实际提示词以 [partitioner.md](backend/resources/prompts/partitioner.md) 和 [planner.md](backend/resources/prompts/planner.md) 为准。Planner 将任务划分为独立工作成果，不提前替节点探索实现步骤；节点数不是优化目标。节点 task 必须自包含目标、用户约束、职责及验收方式。

只有当检查可能改变节点边界、依赖、并行性、可合并性或权威契约时才读取仓库/公开文档。普通边传递上游文件系统状态，不传递对话；只为有意义的有限审查修正流程添加 feedback 边。路径必须相对于当前节点 worktree，禁止嵌入 Planner 所在原仓库的绝对路径。通过编译、覆盖完整后停止规划。

**规划检查边界：**Planner 的 bash 是自定义只读检查接口，不是任意 shell：只接受列目录、搜索、读文件和公开 HTTP(S) 的 curl GET/HEAD；禁止写入、执行脚本、仓库外读取、符号链接、Git 元数据及本机/内网访问。read 使用相同边界。公网请求仍可能携带 URL 信息，GET 不保证远端没有副作用。详见 [规划检查权限](backend/resources/planning-inspection.md)。Graph 执行节点的 OS sandbox 是下述另一层边界。

## 已实现

- Graph IR 以 `name` 为语义标识，边以 `(from, to)` 唯一标识。显式 `feedback` 不可省略。
- 确定性编译：重复名称、空 task、未知节点、自环、重复边、普通依赖环、反馈祖先关系校验；执行层/根/终点和孤立节点警告。
- Graph 需审批，每次节点执行使用新会话和 detached Git worktree；Serial 直接使用用户目录；最大并发可设置为 1–8。
- 并行分支在下游执行前通过宿主 Git merge 组合；Graph 节点受路径 sandbox 保护。整图节点完成后自动合并当前有效节点提交到用户仓库，实际冲突时调用 merger。
- 精确解析最终一行 `<ACCEPT>` / `<REVISE>`；协议错误显式失败；默认最多 3 次自动反馈重试；失败只阻塞依赖分支。
- SQLite append-only 事件日志与 reducer；执行流、工具调用、输出、工作区 SHA、节点 revision、介入指令和历史尝试持久化。
- 暂停停止派发**下一执行波次**，不强杀正在工作的 Pi；等待当前波次完成后可介入或重跑。所有受影响后继失效，无关分支保留。
- 退出时终止受管理 Pi 进程组；重启后端不会自动续跑。被中断的 execution 标记 failed，需人工检查并重跑 fresh session。

## 执行、merger 与结果落地

Serial（当前判定为唯一节点名为 `task`）直接在用户目录执行，结束后由 Workspace Runtime 保存快照。Graph 节点在用户项目旁的 `.grapher-worktrees/<run>/<node>-<id>` 工作；下游启动前由宿主进程合并依赖提交。此阶段有冲突仍将下游标为 **BLOCKED**：人工在冲突 worktree 解决并提交，暂停且等待波次结束后点击 **Use resolved workspace**，再以新 Execution Instance 重跑该节点。

当 Graph 所有节点完成时，`jobs()` 先持久化 `PublicationStarted` 并进入 `publishing`，driver 随后发布当前有效节点 head。跳过已合并的祖先提交，不合并历史失败/失效尝试；Git 仓库和普通文件夹使用相同合并逻辑。普通文件夹通过明确指定外置 `--git-dir` 与用户 `--work-tree` 直接回写，正确处理新增、修改、删除，保持没有 `.git`。回写前检查本地改动，不重新快照来吞掉用户并发修改。只有实际未解决冲突才调用 merger，进入 `merging`；权限、脏目录等错误进入 `publication_failed`。

merger 使用锁定 Pi 内核，在用户源仓库当前 merge 状态中运行。自定义系统提示词只有原始 user query 与冲突修复要求（保留有效修改、避免无关修改、暂存解决结果、检查冲突）；不加载项目 context files 或自动发现的扩展。Pi 仍附加 cwd，工具 schema 仍由 upstream 提供。merger 不使用普通 Graph 节点的源仓库 deny 策略，也不是图中的普通任务或 Planner。

完成后宿主检查未解决条目和 `MERGE_HEAD`，必要时创建 merge commit，校验传入 commit 已成为 HEAD 祖先且目录干净，然后继续剩余节点。只有所有结果确实落地后，`PublicationCompleted` 才将 phase 设为 `completed`，记录最终 SHA 和完成时间。merger 在普通文件夹内运行时仅向其进程树传递 `GIT_DIR/GIT_WORK_TREE`，原生 Git 命令可以工作，无需在用户目录写 `.git`。

工作区顶部的回写面板在各 tab 显示目标路径、正在回写/merger 修复/失败/已写回状态；可选择 merger 历史尝试，查看实时工具输出、session ID、before/after SHA。失败时提供“重试回写”：保留节点结果和冲突现场，重试跳过已完成提交，仅继续本次发布所属的 pending merge，不重新执行图节点、不接管不相关 merge。正在回写时禁止节点介入或普通暂停/恢复，失败通过专用重试入口继续。重启时未完成回写标为失败并显示原因，不自动续用旧 merger 会话。

已落地的前缀提交不自动回滚；仍不能与用户同时写目标目录。旧版本留下的 `Settled/completed` 事件保留原有历史解释，不凭历史记录自动重做回写。

merger 的 session、JSON 输出及 `result.json` 存在 runtime 的 `mergers/<id>/`；生命周期与流式输出写入 SQLite 事件，并投影到 `Snapshot.mergers`，回写状态投影到 `Snapshot.publication`。它是独立 Execution Instance，不伪装成普通 Graph node，也不会和用户命名为 `merger` 的节点冲突。真实模型的语义修复质量需要人工检查；自动测试使用脚本执行器验证完整 HTTP、重启和重试流程，不调用计费模型。

## Graph sandbox

生产 Graph 节点通过 macOS `/usr/bin/sandbox-exec` 启动整个 Node/Pi 进程树。策略由 [sandbox.rs](backend/src/sandbox.rs) 生成，路径先 canonicalize；默认允许宿主其他路径和网络，再拒绝源目录以及整个 `.grapher-worktrees` 树中当前节点以外的目录。因此同一 run、其他 run、profile 生成后才创建的 worktree 都受保护，不依赖目录枚举快照。

| 路径或操作 | Graph 节点权限 |
| --- | --- |
| 当前节点 worktree | 读写、Bash、Pi read/write/edit |
| 源仓库、其他 worktree、指向它们的符号链接 | 禁止读写 |
| worktree 根与当前 run 父目录 | 仅定位路径所需 metadata；不能列出目录内容 |
| 共享 Git common-dir，包括独立 git-dir / shadow metadata | 禁止读写，防止从 Git 对象库读取其他分支 |
| 其他宿主文件、环境认证、网络 | 按宿主权限允许 |

节点内普通 Git 命令可能因无法访问 common-dir 而失败；prepare、snapshot、依赖合并和发布由未套用节点 sandbox 的 Rust 宿主负责。Serial、Partitioner/Planner 和 merger 的 cwd 是用户目录，不使用此 Graph profile；Planner 另有只读工具边界。没有 macOS sandbox 支持时生产 Graph 节点拒绝启动，`fixture` 测试进程不代表生产 sandbox。

这是限定目录的文件访问边界，不是隔离整个宿主机的容器。按设计允许外部文件和网络，因此不防止通过预先存在的外部副本、外部 hardlink、宿主服务或其他代理间接取得同样的数据；不提供网络隔离，也不约束宿主用户和 Rust 的文件访问。适用于防止节点直接探索/改写原项目及其他工作区，不宣称可以执行恶意代码。

Grapher/Pi 安装目录及 runtime 会话目录必须位于被保护源目录之外；否则这些依赖也会被 deny，节点应失败，不能为了启动内核而放开整个源仓库。因此对 Grapher 自身开发 Graph 任务时，需要从另一份外部安装启动宿主。

路径布局：

```text
<project-parent>/
  project/                                      # Serial / merger / 最终发布目录
  .grapher-worktrees/<run>/<node>-<execution>/   # Graph 节点 cwd
<GRAPHER_DATA_DIR or grapher/.grapher>/
  events.sqlite
  planning/<id>/                                # partition/planner 日志及候选图
  sessions/<execution>/                         # 节点会话及 execution-instance.sb
  mergers/<id>/                                 # 冲突会话、output.jsonl、result.json
  shadow_repos/                                 # 普通文件夹的宿主 Git metadata
```

历史会话含源码片段、任务和工具输出，按本地开发数据管理。旧位置的 worktree 不自动迁移，重跑会创建使用新边界的工作区。

## 验证与打包

```sh
export PATH="$HOME/.cargo/bin:$PATH"
npm run build
npm test
cargo check --manifest-path backend/Cargo.toml
cargo build --release --manifest-path backend/Cargo.toml
# macOS: real sandbox processes, upstream tools, test auth and local HTTP
cargo test --manifest-path backend/Cargo.toml --no-default-features --test sandbox -- --nocapture
cargo test --manifest-path backend/Cargo.toml --no-default-features --test graph_merge
npm run test:benchmark
npm run test:publication # Git / 普通文件夹 HTTP 回写、merger 失败重试、重启与 UI 状态
```

2026-09-13 实测环境：macOS 26.6.2、Node 25.4.0。真实 sandbox 测试覆盖：当前目录/外部文件允许读写；源目录、已有/稍后创建/其他 run 的 worktree 拒绝读写；`..`、符号链接、子进程继承；父目录禁止枚举；外置 Git metadata 拒绝访问而宿主 Git 正常；Pi 原生 read/write/edit/bash；Node 本机 HTTP；隔离的测试 auth.json；固定 Pi 入口 `--version`。测试只用假凭据与本机 HTTP 服务，不调用真实 provider API 或模型。测试源码见 [sandbox.rs](backend/tests/sandbox.rs) 和 [sandbox-probe.ts](scripts/sandbox-probe.ts)。macOS 以外不运行这些 OS 用例。

核心测试不调用真实模型，覆盖编译、审批、反馈、失败传播、介入、SQLite replay、重启恢复、实际并行 worktree 合并和冲突；Pi JSON 进程协议使用本地假进程测试。测试用的确定性执行器位于 Cargo `fixture` 特性下（`backend/src/fixture.rs`），出货构建不包含它。发布回归额外覆盖无冲突落地、冲突后继续剩余提交、失败保留现场、脏源目录保护以及 driver 的完成触发时机。

有本地 `pi/` 源码时，还可以验证真实 Pi 扩展加载和 mutation 回滚（不调用模型）：

```sh
cargo build --manifest-path backend/Cargo.toml --no-default-features
node pi/node_modules/tsx/dist/cli.mjs --tsconfig pi/tsconfig.json scripts/check-pi-extension.ts
```

## 目前可能存在的缺陷

- 仅一个活动 Graph，波次式并行调度；执行中修改节点需先暂停并等待波次结束。
- Graph 编辑使用 JSON；没有拖线编辑、自动布局库、完整 xterm 交互终端或多项目管理。
- 暂不自动清理 worktree、安装依赖或迁移未提交改动；历史工作区按需由用户清理。Graph 自动发布支持标准 Git 仓库和普通文件夹；发布时若用户目录有并发改动，明确失败并保留现场，处理后可重试。
- 不支持多引擎、远程执行、自动恢复旧 session、签名/公证/安装更新器。merger 处理整图完成后的冲突，不处理下游 prepare 阶段的 BLOCKED 冲突。
- 普通退出会清理 Pi 进程组。系统断电或后端被 SIGKILL 时不能保证清理；重启会失效未完成尝试，用户需检查残留进程和工作区。
- 支持当前本地 Pi 0.85.1 的 JSON 事件格式及 `--session-id`。真实模型认证/质量需使用用户自己的环境验证。
- Partitioner/Planner prompt 为实验性实现，不把它们当成架构不变量。

## Partitioner / Planner benchmark

主基准评估两件事：**能否分辨线性任务与图任务，以及能否生成高质量执行图**。B010 已替换为规划质量套件，旧的 Pi 写文件测试已删除。

```sh
npm run benchmark                         # 3 个 serial + 3 个 graph 任务，各采样一次
npm run benchmark:planner                 # 只评估 Planner：3 个图任务，不调用 Partitioner
npm run benchmark -- --task P005           # 契约、双 SDK、审查反馈的定向评估
npm run benchmark:validate                 # 每个任务固定采样 3 次
npm run test:benchmark                     # 评分器回归，不调用模型
npm run benchmark:runtime                  # B001–B009/B011 执行机制回归，不计入规划得分
```

规划宿主复用出货的 prompts、Pi 工具扩展、逐次 mutation 编译器和最终编译器，**不创建 Runtime、不审批、不执行图中的节点**。正确路由、目标覆盖、节点指令自包含、依赖顺序、有效并行、文件边界及反馈路径分别评估。即使 Partitioner 把图任务误判为 serial，也会独立调用 Planner 暴露它的生成质量；路由错误仍记为失败。

语义评审由独立、无工具的模型调用完成，以节点任务行号取证，评分器提取并保存原文；确定性检查还覆盖责任归属、依赖可达性、独立分支、反馈边，以及是否把 worker 错误绑定到原始仓库绝对路径。模型评分仍需审阅，不等同于独立人工金标或实际执行成功。可用 `BENCHMARK_JUDGE_MODEL` 单独设置评审模型；`BENCHMARK_PI_MODEL` 设置待评估模型，`BENCHMARK_PI_COMMAND` / `BENCHMARK_PI_ARGS` 设置现有 Pi 安装。

结果在 `benchmark-results/<run-id>/`：保存目标、仓库、隐藏评分标准、实际生成图、路由、编译诊断、模型原始输出、评审证据、耗时和 token。`--replay <结果目录>` 可以离线重算；加 `--rejudge` 则仅重跑评审，复用原始候选图。新结果使用 schema v2 / `planning-quality-v1`，不与旧 B010 写文件成绩混用。设计与覆盖边界见 [benchmark contract](benchmark/architecture.md) 和 [system under test](benchmark/system-under-test.md)。

历史执行机制报告和原始失败证据继续保留；其中的通过率不作为 Partitioner／Planner 质量成绩。本次实测与发现见 [规划 benchmark 报告](benchmark/report-planning.md)。
