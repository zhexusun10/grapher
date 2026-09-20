# Grapher

Don't orchestrate agents. Compile work.

Grapher 是本地 Agent Runtime：它把用户目标路由为单节点任务或编译后的执行图，再由确定性 Rust Runtime 调度 fresh Pi Execution Instances。浏览器端使用 React/TypeScript，后端使用 Rust、Git 和 SQLite。

系统边界与运行时语义见 [agent.md](agent.md)。

Docker/容器执行实现已移除，当前执行入口为宿主原生 Pi。Graph 文件工具映射统一源项目路径，bash 转换完整项目路径字面量，模型侧提示与工具输出使用统一项目路径。Seatbelt 保护源目录、兄弟工作区和其他 session；脚本文件内部硬编码路径及程序动态拼接路径仍不透明映射。完整逻辑、取舍与验证见 [原生执行实现说明](engine/native-execution.md)。

## 环境要求

- macOS 与系统自带 sandbox-exec：目前验证此平台的原生执行与路径保护；Linux/Windows 后端尚未验证。
- Node.js 22.19+
- Rust stable
- Git、npm
- 可用的 Pi provider 认证和网络环境

Pi 以锁定 commit 的 submodule 提供，不使用全局 Pi 替代。基线和同步流程见 [engine/README.md](engine/README.md)。原生入口不会退回其他执行器，访问策略或运行副本准备失败时明确报错。

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

Planner 已落地的文件不会因 Reject 回滚。批准（包括 Serial 自动批准）会暂存并提交源目录当前变更，包含用户此前未提交的修改，并改变暂存状态。原绑定目录不存在或不可访问时，界面显示失效，后端拒绝执行；重新选择目录建立新绑定即可，不搜索、迁移或重写旧绝对路径。切换查看其他项目不会修改后台 run 的绑定。

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
| `PI_CODING_AGENT_DIR` | 共享 Pi 配置/认证目录，默认 `~/.grapher/pi-agent` |
| `PARTITIONER_MODEL` | 覆盖 Partitioner 模型 |
| `PLANNER_MODEL` | 覆盖 Planner 模型 |
| `NODE_AGENT_MODEL` | 覆盖执行节点模型 |
| `MERGER_MODEL` | 覆盖发布冲突处理模型 |
| `*_THINKING` | 对应角色的 thinking 配置 |
| `*_TIMEOUT_SECONDS` | 对应角色超时 |
| `PARTITIONER_SYSTEM_PROMPT` | 开发用 Partitioner prompt 覆盖 |
| `PLANNER_SYSTEM_PROMPT` | 开发用 Planner prompt 覆盖 |

Partitioner 模型跟随全局配置（或由 `PARTITIONER_MODEL` 覆盖）；思维链永远关闭（`thinking=off`，若底层模型不支持完全关闭则自动设为该模型允许的最低档位）。各角色配置互相隔离，不继承外层 Pi 会话的模型或 session 环境变量。

## 项目结构

```text
backend/src/       Rust Compiler、Runtime、Workspace、HTTP API、SQLite
backend/resources/ Partitioner/Planner prompts 与工具权限契约
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

原生入口、工具、映射实验和 Git 发布测试：

```sh
npm run test:native
npm run test:extensions
npm run test:bindings
npm run probe:native-mapping
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --test graph_merge
```

`fixture` 测试使用确定性执行器，不调用真实模型，也不能证明透明路径映射有效。`probe:native-mapping` 退出码 0 表示预期反例复现，报告仍明确 `contractSatisfied: false`。真实模型认证和语义质量需要在用户自己的 provider 环境中验证。

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
- Pi 文件工具及 bash 完整路径字面量映射项目路径；脚本文件内部写死的源项目路径或程序动态拼接路径可能被拒绝，不会自动重定向。
- 当前源目录角色使用宿主环境，HOME/全局工具的修改会影响用户。进程组取消不能保证清理已脱离的后代，完整后台进程和崩溃恢复尚未验证。
- 批准执行时会提交源目录当前的非忽略文件变更，作为 planner 完成后的节点基线；被 Git 忽略的未跟踪文件不随快照传播。共享 HOME/临时文件不具备节点快照的版本隔离。
- 若数据目录存在旧执行器的未清理 lease，后端拒绝启动；需要先用旧版本停止对应执行并确认没有后台写入。新版本不会调用旧执行器或删除这些记录。
- 认证目录改为 `~/.grapher/pi-agent`；旧 `~/.pi/agent` 凭据不自动迁移，可重新登录或显式设置 `PI_CODING_AGENT_DIR`。
- 暂停不会强杀活动 execution；等待其结束后才能介入。
- 后端重启不会恢复旧模型会话，中断任务会标记失败并暂停。
- 用户目录在发布期间不能并发修改；检测到脏状态会保留结果并进入发布失败。
- 下游 prepare 冲突由人工处理；自动 merger 只处理最终发布冲突。

## 文档索引

- [系统架构与不变量](agent.md)
- [Pi 基线、适配边界与升级流程](engine/README.md)
- [原生执行与路径映射完整说明](engine/native-execution.md)
- [Planner 工具权限](backend/resources/planning-inspection.md)
- [Planner prompt](backend/resources/prompts/planner.md)
- [Partitioner prompt](backend/resources/prompts/partitioner.md)
- [Benchmark 契约](../grapher-tests/benchmark/architecture.md)
