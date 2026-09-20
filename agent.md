# Grapher 架构

> Don't orchestrate agents. Compile work.

本文描述 Grapher 当前实现的架构边界与关键不变量。安装、启动和开发命令见 [README.md](README.md)；Pi 基线与同步流程见 [engine/README.md](engine/README.md)；Planner 的实际行为以 [planner.md](backend/resources/prompts/planner.md) 和 [partitioner.md](backend/resources/prompts/partitioner.md) 为准。

## 1. 系统定位

Grapher 将用户目标先编译为执行图，再由确定性 Runtime 执行。LLM 负责路由、规划和节点内工作，不负责运行期调度。

```text
User goal
   |
   v
Partitioner -------- serial ------> one Node Agent
   |
 graph
   v
Planner -> Graph IR -> Compiler -> Approval
                                   |
                                   v
                            Graph Runtime
                              /   |   \
                         fresh Execution Instances
                                   |
                            workspace commits
                                   |
                                publish
```

核心分工：

- **Partitioner**：判断任务走 `serial` 还是 `graph`，不解决任务。
- **Planner**：读取仓库并生成 Graph IR，图编译通过后退出。
- **Compiler**：确定性校验图并生成执行批次、根节点和终点。
- **Graph Runtime**：调度、并发、反馈、失效传播、暂停和恢复。
- **Workspace Runtime**：准备隔离仓库、组合依赖提交、保存快照和发布结果。
- **Pi**：唯一生产 Execution Instance Engine，执行具体模型会话。
- **Rust backend**：运行时状态和持久化的唯一权威。
- **React UI**：展示投影并提交操作，不持有运行时真相。

Grapher 不运行一个持续在线的 LLM Coordinator。Planner 完成后，调度与状态迁移不再依赖 Planner token。

## 2. 代码边界

| 路径 | 职责 |
| --- | --- |
| `backend/src/compiler.rs` | Graph IR 静态校验与执行计划 |
| `backend/src/runtime.rs` | 事件驱动状态机、调度、反馈与介入 |
| `backend/src/workspace.rs` | Git/shadow repository、节点工作区和快照 |
| `backend/src/graph_merge.rs` | 最终发布与冲突 merger |
| `backend/src/engine.rs` | Pi 进程、角色配置、超时和反馈协议 |
| `backend/src/provider_auth.rs` | Provider/Auth Adapter 的本地进程桥接 |
| `backend/src/native.rs` | 宿主原生入口、映射能力门槛与认证目录 |
| `backend/src/store.rs` | SQLite append-only 事件存储 |
| `backend/src/server.rs` | 本地 HTTP API、规划流程和 runtime driver |
| `engine/` | 锁定 Pi 入口、模型数据与适配层 |
| `src/` | React UI、运行时服务和图/会话视图 |
| `../grapher-tests/benchmark/` | 外置规划质量与 Runtime 回归，不属于产品运行路径 |
| `pi/` | 未修改的 upstream Pi submodule |

## 3. 规划与 Graph IR

### 路由

Partitioner 是无工具的单轮分类器：

- `serial`：单一或高度线性的工作，后端创建唯一的 `task` 节点并自动批准。
- `graph`：存在多个可独立推进的实质工作流，进入 Planner 和人工审批流程。

模型调用失败必须显式失败；只有成功调用但分类文本含糊时才回退到 `serial`。

### Planner 边界

Planner 只有四个工具：

- `node`：创建、更新或删除节点。
- `edge`：创建、更新或删除边。
- `read`：Pi 原生读取工具，不额外限制仓库范围、符号链接或 Git metadata。
- `bash`：Pi 原生 shell 工具，不再拦截写操作。

Planner 没有文件 edit/write 工具，也不参与运行期调度。bash 直接操作源目录，文件变化立即生效，不自动备份或回撤；Reject 只拒绝计划，不恢复文件。完整边界见 [planning-inspection.md](backend/resources/planning-inspection.md)。

节点 task 必须自包含目标、约束、职责边界和验收方式。普通依赖边只表达文件状态或执行顺序依赖；逻辑可并行但会大量修改同一文件的工作不应强行并行。

### 数据模型

```ts
interface Graph {
  originalGoal: string;
  nodes: Array<{ name: string; task: string }>;
  edges: Array<{
    from: string;
    to: string;
    relation: string;
    feedback: boolean;
  }>;
}
```

`name` 是图内语义标识；边由 `(from, to)` 唯一标识。`feedback` 必须显式提供。同一 source 最多只能有一条 outgoing feedback edge，因为反馈 verdict 不携带 target。

边分为两类：

- **Dependency edge** (`feedback=false`)：`A -> B` 表示 B 等待 A 成功完成。
- **Feedback edge** (`feedback=true`)：从下游节点指回其依赖祖先，表示受控修订路径。

移除 feedback edges 后，普通依赖图必须是 DAG。

### 编译器

Compiler 校验：

- 节点名称格式、唯一性、数量上限和非空 task。
- 边端点存在、无自环、`(from, to)` 不重复。
- 每个 source 最多一条 outgoing feedback edge。
- 普通依赖图无环。
- feedback target 是 source 的普通依赖祖先。

Compiler 输出 `executionBatches`、`roots`、`terminals` 和 warnings。Mutation 被拒绝时不修改候选图，Planner 根据 diagnostic 修正。Graph 路由只有在最终编译通过且用户批准后才能执行。

## 4. Runtime 语义

### Node 与 Execution Instance

Graph Node 是稳定的任务定义；Execution Instance 是一次执行尝试。每次首次运行、反馈重跑或人工介入都会创建新的 Pi session，不恢复旧会话。历史 execution 只读保留。

节点状态为：

```text
waiting -> running -> done
            |          |
            v          v
          failed     dirty -> running

waiting/dirty -> blocked
```

- `blocked`：依赖失败或工作区组合冲突。
- `dirty`：节点或其上游变化使当前结果失效。

### 调度

普通 DAG 在依赖满足且并发槽可用时立即派发，不等待同批慢节点。并发上限为 1 到 8。

含 feedback edge 的图使用波次屏障：当前活动 execution 全部结束后，Runtime 先处理反馈和失效传播，再派发下一波，避免消费者使用即将失效的结果。

失败只阻塞依赖分支；无关分支继续。暂停只停止新派发，不强杀正在运行的 Pi。

### Feedback

拥有 outgoing feedback edge 的节点会自动收到响应协议：最终一行必须是 `<ACCEPT>` 或 `<REVISE>`。每个 source 最多一条 outgoing feedback edge；Compiler 拒绝一个 source 指向多个 target，因为 verdict 本身不选择 target。

- `<ACCEPT>`：不触发反馈。
- `<REVISE>`：触发该 source 的唯一 outgoing feedback edge，使 target 及其普通依赖后继失效并重新执行。
- 协议错误：当前 execution 失败。
- 超过 `maxFeedback`：来源分支失败，无关分支继续。

当两个并行实现都可能需要独立修订时，使用以下任一可表达结构：

```text
frontend ----\
              integration -> review
backend -----/                 |
               ^--------------+ feedback
```

这里 `integration` 是合并后结果的修订 owner，`review` 只有一条 feedback edge 指回它。或者为两个实现分别设置 reviewer，每个 reviewer 只反馈给自己的实现 owner，再让后续 integration 消费两条已验收分支。不要创建同一个 `review` 同时 feedback 到 `frontend` 和 `backend` 的图；当前协议无法表达“只修其中一个”。

路由由 Graph 决定，评价由节点完成，状态迁移由 Runtime 完成。

### 人工介入

用户必须先暂停并等待活动 execution 结束，之后可向某节点追加指令。Runtime 增加该节点 revision，并将它和普通依赖后继标为 `dirty`；重跑使用 fresh Execution Instance。

下游工作区组合发生 Git 冲突时，节点进入 `blocked`。用户在保留的工作区完成并提交冲突解决后，通过 `Use resolved workspace` 继续；原任务仍由新的 Execution Instance 完成。

## 5. Workspace 与发布

节点之间传递的是 Git 表示的文件系统状态，不是对话或自定义 artifact schema。

### Serial

Partitioner 明确选择 Serial 后，唯一 `task` 节点直接在用户目录执行。运行模式单独持久化；Planner 生成的单个 `task` 节点仍按 Graph 隔离。旧事件没有模式字段时保留旧版按图形状判断的行为。Serial 完成后保存快照，不进入整图发布阶段。

### Graph

Graph 节点位于：

```text
<project-parent>/.grapher-worktrees/<run>/<node>-<execution>/
```

目录名保留 `worktrees`，但当前实现是**独立 Git 仓库**，不是 `git worktree`。每个节点有私有 `.git` 和完整所需历史，不共享 Git common-dir。

工作区流程：

1. Planner 完成并批准后，宿主将源目录当前非忽略文件变更提交为基线，再放入 `refs/grapher/base` 和 `refs/grapher/heads/<sha>`；节点工作区随后才分配。
2. 节点仓库通过 `file://` fetch 基线和父节点 refs。
3. 多个父依赖在节点执行前由宿主合并。
4. 节点完成后提交工作区修改。
5. 宿主 fetch 到 `refs/grapher/nodes/<node>` 及 `refs/grapher/heads/<sha>`。

关键不变量：每个完成节点都必须在宿主侧有可传播的 Grapher-owned ref。跨仓库传输使用 advertised ref，不依赖按裸 SHA fetch。所有 fetch 使用 `--no-write-fetch-head`，避免并发写 `FETCH_HEAD`。

### 普通文件夹

非 Git 目录使用 `.grapher/shadow_repos/` 下的外置 Git metadata。用户目录不创建 `.git`，但节点组合、快照和发布仍使用相同 Git 语义。

### 最终发布

所有 Graph 节点完成后：

```text
running -> publishing -> completed
                    \
                     -> merging -> publishing
                     -> publication_failed
```

Runtime 先持久化 `PublicationStarted`，再把当前有效节点 heads 合并回用户目录。已是目标 HEAD 祖先的提交会跳过；历史失败或失效尝试不会发布。

只有实际 Git 冲突才启动专用 merger Execution Instance。merger 不是图节点，也不唤醒 Planner；它在用户目录的现有 merge 状态中解决冲突。权限错误、脏目录或缺失仓库直接进入 `publication_failed`。

发布失败保留已落地提交和冲突现场。`retry_publication` 复用原 heads，从当前状态继续，不重跑图节点。所有 heads 成为最终 HEAD 的祖先且目录干净后，才发出 `PublicationCompleted`。

## 6. 角色与隔离

| 角色 | 工具/扩展 | 工作目录与权限 |
| --- | --- | --- |
| Partitioner | 无工具、无 skills/extensions | 用户仓库，只做分类 |
| Planner | `node/edge/read/bash`，仅显式 Grapher extension | 用户仓库，原生 bash 不拦截写操作；Reject 不回撤文件 |
| Node Agent | Pi 原生工具，可加载 skills/extensions | Serial 在用户目录；Graph 在独立节点仓库 |
| Merger | `read/write/edit/bash`，无自动扩展发现 | 用户目录，仅处理最终发布冲突 |

生产入口已改为宿主 Node 启动固定 Pi，Docker/容器实现已删除：

- Planner、Partitioner、Serial 和 Merger 在源项目真实绝对路径执行；宿主 PATH、HOME、TMPDIR、外部文件与原生工具直接可用。
- Graph 文件工具映射源项目路径，bash 转换可识别的完整项目路径字面量；模型侧输出规范为统一源项目路径。脚本文件内部硬编码路径和程序动态拼接路径不透明映射，直接越界访问由 Seatbelt 拒绝。
- Planner 写入立即生效，Reject 不回撤。批准后快照再分配工作区的代码与回归保留。
- 文件写入内容和已有脚本不改写；Graph 的命令字面量与模型侧路径呈现由适配器处理（不是通用内核映射）。Planner 编译器使用宿主 Rust binary；会话使用真实独立目录，认证使用专用 Pi 配置目录。Graph 引擎在源外准备一份共享只读运行副本，保护源目录时不阻断自身。
- 当前取消仅清理进程组，不能声称覆盖已脱离的后代或外部服务；完整后台写入屏障与崩溃恢复仍未验证。
- 检测到旧执行器 lease 时拒绝后端启动，不调用旧执行器或删除记录；必须先确认旧执行已经停止。

完整逻辑、验证与边界见 [native-execution.md](engine/native-execution.md)。

Node Agent 可加载工作区 skills/extensions。批准时会将新增非忽略文件纳入基线；Git 忽略的未跟踪依赖文件不会进入快照。共享 HOME/临时目录中的文件保留，但不受 Git 快照和节点版本隔离管理。

## 7. Pi、模型与认证

Pi 是唯一生产 Execution Instance Engine。生产入口固定为 `engine/entrypoint.mjs`，版本、依赖锁和模型目录校验由 `engine/pi-lock.json` 与 setup 脚本管理。

角色可独立覆盖模型、thinking 和超时：

```text
PARTITIONER_MODEL / PARTITIONER_THINKING / PARTITIONER_TIMEOUT_SECONDS
PLANNER_MODEL     / PLANNER_THINKING     / PLANNER_TIMEOUT_SECONDS
NODE_AGENT_MODEL  / NODE_AGENT_THINKING  / NODE_AGENT_TIMEOUT_SECONDS
MERGER_MODEL      / MERGER_THINKING      / MERGER_TIMEOUT_SECONDS
```

Partitioner 默认 `thinking=off`。后端启动 Pi 前会移除继承的 `PI_MODEL`、`PI_THINKING`、`PI_PROVIDER`、`PI_REASONING_LEVEL`、`PI_SESSION_ID` 和 `PI_SESSION_FILE`，再显式设置本次角色配置。

Provider/Auth Adapter 委托 upstream `ModelRuntime` 完成 provider catalog、登录、轮询、交互响应、登出和凭据管理。Rust 与浏览器不读取或保存 Pi 的 token/key。宿主 Adapter、交互 `npm run pi` 和原生执行共享专用 `~/.grapher/pi-agent`（可由 `PI_CODING_AGENT_DIR` 覆盖），旧凭据不自动迁移。

## 8. 持久化与恢复

SQLite 保存 append-only Graph events；`Snapshot` 是事件 reducer 的当前投影。核心数据包括：

- Graph、Config、Plan 与节点状态。
- Execution / merger 元数据和工作区 revision。
- Feedback、人工介入、审批、暂停和发布事件。
- Planning identity 与汇总指标。

完整 execution 输出和 planning JSONL 按会话保存在数据目录，普通 snapshot/list API 只返回 metadata。UI 按 `(runId, executionId, byteOffset)` 或 planning cursor 分页读取，单页最多 256 KiB。

默认布局：

```text
.grapher/
  events.sqlite
  runtime.lock
  planning/<planning-id>/
  sessions/<execution-id>/
  mergers/<merger-id>/
  shadow_repos/
```

可通过 `GRAPHER_DATA_DIR` 改变数据目录。

恢复规则：

- 后端重启不会自动恢复旧模型会话。
- 中断的 execution 标记为 failed，run 暂停。
- 中断的 planning 标记为 failed，保留已有输出。
- 中断的 publication/merger 转为 `publication_failed`，由用户显式重试。

## 9. 前后端契约

Rust backend 同时提供本地 HTTP API 和生产静态页面。前端开发服务器只负责 Vite 与 `/api` 代理。

React UI 负责：

- 工作区选择、目标提交和规划输出。
- Graph 审批、状态可视化和执行时间线。
- Execution/merger 日志分页展示。
- 暂停、恢复、介入、冲突确认和发布重试。

前端不得自行推导权威状态或模拟后端执行。所有状态来自 Runtime snapshot/event projection。

## 10. 当前约束

- 同一数据目录只允许一个 Grapher Runtime 持有文件锁。
- 当前产品面向本机单活动 Graph，不支持远程节点或多引擎。
- 当前验证 macOS 原生 Graph 入口和文件工具映射；不提供任意子进程透明路径重定向。
- 源/兄弟/session 的普通直接及符号链接写入拒绝已验证；间接服务、硬链接、跨进程描述符等不构成已证明的恶意租户隔离。
- 不自动清理历史节点工作区，也不自动安装目标项目依赖。
- 用户不能在 Graph 发布期间并发修改目标目录；脏目录会使发布失败。
- prepare 阶段冲突由人工处理；merger 只处理最终发布冲突。
- Runtime 不自动恢复被中断的 Execution Instance。
- Planner 工具不是 sandbox；所有写入直接生效，Reject 不恢复文件或其他副作用。

## 11. 架构不变量

1. Planner plans; Compiler validates; Runtime executes; Pi works.
2. Planner 不派发 agent，也不参与运行期协调。
3. 每次节点尝试都是 fresh Execution Instance。
4. 普通依赖图必须是 DAG；循环只能通过显式 feedback edge 表达，且每个 feedback source 只能指向一个 target。
5. Graph 节点通过 Git 文件系统状态协作，不传递对话历史。
6. Runtime 和 SQLite event log 是状态权威，UI 只是投影。
7. Graph 结果只有成功发布到用户目录后才算 completed。
8. 能由 Compiler、Runtime、Git 和状态机确定性完成的工作，不交给 LLM Coordinator。
