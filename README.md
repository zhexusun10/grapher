# Grapher

Don't orchestrate agents. Compile work.

Grapher 是本地 Agent Runtime：它把用户目标路由为单节点任务或编译后的执行图，再由确定性 Rust Runtime 调度 fresh Pi Execution Instances。浏览器端使用 React/TypeScript，后端使用 Rust、Git 和 SQLite。

系统边界与运行时语义见 [agent.md](agent.md)。

## 环境要求

- macOS：生产 Graph 节点依赖 `/usr/bin/sandbox-exec`；缺少它时 Graph 执行会拒绝启动。
- Node.js 22.19+
- Rust stable
- Git、npm
- 可用的 Pi provider 认证和网络环境

Pi 以锁定 commit 的 submodule 提供，不使用全局 Pi 替代。基线和同步流程见 [engine/README.md](engine/README.md)。

## 安装与启动

```sh
git submodule update --init --recursive
npm ci --ignore-scripts
npm run pi:setup
npm run dev
```

打开 <http://127.0.0.1:1420>。`npm run dev` 同时启动 Vite 和 Rust 后端；首次启动需要等待 Cargo 构建。

也可以分开启动：

```sh
npm run backend   # http://127.0.0.1:1421
npm run frontend  # http://127.0.0.1:1420
```

生产模式由 Rust 后端同时提供页面和 API：

```sh
npm run build
npm start
```

打开 <http://127.0.0.1:1421>。服务只监听本机地址。`GRAPHER_PORT` 可修改后端端口；分开启动时前后端必须使用相同值。

## 基本流程

1. 在设置中选择本机项目目录。支持干净且已有 commit 的 Git 仓库，也支持普通文件夹。
2. 选择模型并通过 Provider 设置完成认证；也可运行 `npm run pi` 使用 upstream CLI 登录。
3. 输入目标。Partitioner 选择 `serial` 或 `graph`。
4. Serial 自动创建并批准唯一的 `task` 节点，直接在项目目录执行。
5. Graph 由 Planner 生成并经 Compiler 校验；用户检查完整图后点击批准。
6. Runtime 在隔离的独立 Git 仓库中执行节点、组合依赖并处理反馈。
7. 所有节点完成后，Runtime 将当前有效结果发布回项目目录；只有发布成功后 run 才是 completed。

普通文件夹通过 `.grapher/shadow_repos/` 中的外置 Git metadata 工作，项目目录不会增加 `.git`。

### 独立节点

Graph 的普通依赖图不要求整体连通，可以包含多个互不相连的 DAG component。没有 incoming 或 outgoing dependency edge 的节点是合法的独立节点；它同时出现在 `roots` 和 `terminals` 中，依赖并发槽直接执行。Runtime 最终发布各 terminal 的有效 head；依赖祖先已包含在下游 terminal 的 Git 历史中，而独立节点自身就是 terminal，因此它的文件结果不会因为没有边而被忽略。

Edge 只表示真实的文件状态或执行顺序依赖。不要仅为了让图连通而给独立节点添加虚假 dependency edge。若多个独立节点修改相同文件，它们的结果仍可能在后续组合或最终发布时产生 Git 冲突。

## 配置

界面配置：

- `repository`：项目绝对路径。
- `model`：Pi 模型，可写为 `provider/model`。
- `maxParallel`：Graph 并发数，范围 1 到 8。
- `maxFeedback`：每条 feedback 路径最大自动修订次数，范围 0 到 10。

常用环境变量：

| 变量 | 说明 |
| --- | --- |
| `GRAPHER_PORT` | 后端端口，默认 `1421` |
| `GRAPHER_DATA_DIR` | SQLite、会话、规划和 shadow repository 数据目录 |
| `PARTITIONER_MODEL` | 覆盖 Partitioner 模型 |
| `PLANNER_MODEL` | 覆盖 Planner 模型 |
| `NODE_AGENT_MODEL` | 覆盖执行节点模型 |
| `MERGER_MODEL` | 覆盖发布冲突处理模型 |
| `*_THINKING` | 对应角色的 thinking 配置 |
| `*_TIMEOUT_SECONDS` | 对应角色超时 |
| `PARTITIONER_SYSTEM_PROMPT` | 开发用 Partitioner prompt 覆盖 |
| `PLANNER_SYSTEM_PROMPT` | 开发用 Planner prompt 覆盖 |

Partitioner 默认 `thinking=off`。各角色配置互相隔离，不继承外层 Pi 会话的模型或 session 环境变量。

## 项目结构

```text
backend/src/       Rust Compiler、Runtime、Workspace、HTTP API、SQLite
backend/resources/ Partitioner/Planner prompts 与只读检查契约
engine/            锁定 Pi 入口、Provider/Auth host、模型数据
src/               React UI 与 HTTP client
scripts/           开发、Pi 基线和 HTTP/UI 回归脚本
../grapher-tests/benchmark/  外置规划质量和 Runtime benchmark
../grapher-tests/backend-tests/ 外置 Rust 集成测试
pi/                upstream Pi submodule
```

详细职责映射见 [架构文档](agent.md#2-代码边界)。

## 数据与工作区

默认运行数据在仓库根目录 `.grapher/`：

```text
.grapher/
  events.sqlite
  planning/<planning-id>/
  sessions/<execution-id>/
  mergers/<merger-id>/
  shadow_repos/
```

Graph 节点工作区位于目标项目旁：

```text
<project-parent>/.grapher-worktrees/<run>/<node>-<execution>/
```

该目录虽然沿用 `worktrees` 名称，内部实际是私有 `.git` 的独立仓库。历史会话和工作区可能包含源码片段、工具输出及模型响应，应按本地开发数据管理；当前版本不自动清理它们。

## 验证

常规检查：

```sh
npm run check
npm run build
npm test
npm run test:benchmark
cargo fmt --manifest-path backend/Cargo.toml -- --check
```

完整本地验证：

```sh
npm run test:pi
npm run test:http
node scripts/cargo.mjs check --manifest-path backend/Cargo.toml --no-default-features
cargo build --release --manifest-path backend/Cargo.toml
```

真实 macOS sandbox 和 Git 发布测试：

```sh
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --test sandbox -- --nocapture
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --test graph_merge
```

`fixture` 测试使用确定性执行器，不调用真实模型，也不能证明生产 sandbox 有效。真实模型认证和语义质量需要在用户自己的 provider 环境中验证。

## Benchmark

```sh
npm run benchmark                 # 3 serial + 3 graph case
npm run benchmark:planner         # 只评估 graph planning
npm run benchmark:validate        # 每个 case 固定采样 3 次
npm run benchmark:runtime         # 执行机制回归
npm run test:benchmark            # grader 回归，不调用模型
```

规划 benchmark 不创建 Runtime、不批准图、不执行节点。Harness 与测试源码位于 Grapher 仓库外的 sibling `../grapher-tests/`；Cargo manifest 和 npm scripts 只引用这些外置文件。默认证据写入 Grapher 仓库旁的 `grapher-benchmark-results/`，可通过 `GRAPHER_BENCHMARK_RESULTS_DIR` 覆盖。评测契约见 [外置 benchmark 架构](../grapher-tests/benchmark/architecture.md)，被测系统边界见 [system-under-test.md](../grapher-tests/benchmark/system-under-test.md)。

## 已知约束

- 当前只支持一个活动 Graph 和本地执行，不支持远程节点或多执行引擎。
- Graph 节点路径隔离依赖 macOS Seatbelt；它不是容器或网络隔离。
- 对 Grapher 自身运行 Graph 任务时，需要从目标仓库外的另一份安装启动，并将 `GRAPHER_DATA_DIR` 放在目标仓库外。
- 暂停不会强杀活动 execution；等待其结束后才能介入。
- 后端重启不会恢复旧模型会话，中断任务会标记失败并暂停。
- 用户目录在发布期间不能并发修改；检测到脏状态会保留结果并进入发布失败。
- 下游 prepare 冲突由人工处理；自动 merger 只处理最终发布冲突。

## 文档索引

- [系统架构与不变量](agent.md)
- [Pi 基线、适配边界与升级流程](engine/README.md)
- [Planner 只读检查权限](backend/resources/planning-inspection.md)
- [Planner prompt](backend/resources/prompts/planner.md)
- [Partitioner prompt](backend/resources/prompts/partitioner.md)
- [Benchmark 契约](../grapher-tests/benchmark/architecture.md)
