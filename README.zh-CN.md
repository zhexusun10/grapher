# Grapher

> **不编排智能体，编译工作。**
>
> Don't orchestrate agents. Compile work.

[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Grapher 是一个**基于 [Pi](https://github.com/earendil-works/pi) 的本地 Coding Agent 工作台**。它可以直接运行单 Agent 编程任务，也可以将复杂工作编译成可检查的执行图，由确定性的 Rust 运行时执行。独立 Agent 通过 Git 协作，而不是依赖“主管 Agent”的持续对话。

[快速开始](#快速开始) · [工作方式](#工作方式) · [架构](docs/architecture/overview.md) · [English](README.md)

![Grapher 真实界面：审批前的示例图，包含前后端并行任务、集成和有界审查反馈](assets/execution-graph.png)

*真实 Grapher 界面，展示等待审批的示例图。使用固定样例数据，不是真实模型执行记录或性能测试。*

## 为什么选择 Grapher？

- **Pi 的图形化工作台** — 在同一个界面中与 Coding Agent 对话、管理服务商登录与模型设置、查看工具调用和日志、追加指令。单 Agent 编程无需规划任务图。
- **确定性编排** — 调度、依赖、重试和反馈是明确的 Rust 状态转换，不隐藏在 LLM 对话中。
- **Git 原生协作** — Agent 交换文件状态和提交，而不是彼此的聊天记录；Graph 节点使用独立 Git 仓库。
- **可检查的执行图** — 执行前查看并批准任务图，执行中清楚看到依赖、并行分支和有次数限制的返工。
- **本地优先** — 在你的机器上运行；Graph 的有效结果成功发布回代码库后才宣告完成。模型请求仍会发送给你配置的服务商。

## 什么时候应该使用 Grapher？

**Agent 并不是越多越好。** 当编程任务包含独立工作流时，Grapher 更有用，例如：

- 前端 + 后端修改
- 实现 + 测试
- 多个独立模块
- 实现后进行有界审查 / 返工

小型、线性或高度耦合的任务应使用 **Serial**；当独立工作流和显式依赖值得拆图时，再使用 **Graph**。**Auto** 可让 Partitioner 选择路线。

| | Serial | Graph |
| --- | --- | --- |
| 适合任务 | 小型 / 线性任务 | 独立工作流 |
| 编程 Agent | 一个 | 一个或多个任务节点 |
| 规划 | 直接执行 | 编译执行图 |
| 审批 | 自动 | 默认由用户批准 |
| 工作区 | 用户项目 | 独立 Git 仓库 |
| 调度 | 顺序执行 | 依赖感知、有界并行 |

规划副作用和发布语义见[执行模型](docs/architecture/execution-model.md)。Graph 是执行路线，不是 Agent 数量要求；图也可以只有一个节点。

## 快速开始

**依赖：** Node.js 22.19+、稳定版 Rust、Git、npm、网络和服务商认证。Windows 需要 Git for Windows Bash；Linux Graph 需要 bubblewrap，并允许非特权 user/mount/PID namespace。各平台安装前提和排错见[安装指南](docs/guides/installation.md)。

```sh
git clone --recurse-submodules https://github.com/zhexusun10/grapher.git
cd grapher
npm ci --ignore-scripts
npm run pi:setup
npm run dev
```

打开 **<http://127.0.0.1:1420>**。首次启动可能需要等待 Cargo 编译。

1. 在**设置**中选择本机项目，完成服务商认证并选择 `provider/model`。也可通过 `npm run pi` 登录；详见[服务商指南](docs/guides/providers.md)。
2. 输入编程目标。选择 **Serial** 使用单个 Pi Agent，选择 **Graph** 规划任务图，或让 **Auto** 由 Partitioner 判断路线。
3. Graph 模式下查看并**批准**计划。执行中可查看节点日志、暂停新任务派发，或追加指令。
4. Graph 的有效结果成功发布回项目后才算完成；发布失败会保留状态供检查或重试。

**只在可信项目上使用，首次体验建议用可丢弃的项目。** 成功规划可能在审批前将 Planner 修改合并到源项目，快照也可能暂存并提交已有非忽略变更。拒绝计划不等于回滚。Windows 工作区不是文件系统沙箱。在重要代码上运行前，请阅读[执行模型](docs/architecture/execution-model.md)和[文件系统边界](docs/architecture/filesystem-isolation.md)。

已有克隆仓库请先运行 `git submodule update --init --recursive`。Pi 是锁定版本，不会使用全局 Pi 替代。

本机生产模式：

```sh
npm run build
npm start
```

打开 <http://127.0.0.1:1421>。配置、凭据、数据目录和启动问题见[安装指南](docs/guides/installation.md)。

## 工作方式

```text
编程目标
    |
    v
任务路由器 Partitioner
    |-- 单一 / 线性任务 --> Serial Agent --> 用户项目
    |
    '-- 独立工作流
           |
           v
        Planner
           |
           v
        执行图 --> 编译器 --> 用户批准
                                |
                                v
                         确定性 Rust 运行时
                           |      |      |
                        Agent A Agent B Agent C
                           '--- Git 状态 ---'
                                |
                                v
                            发布到项目
```

模型负责拆分工作和执行具体任务，编译器负责验证图。编译完成后，规划器可以退出：调度不再依赖协调器的下一条消息。普通依赖构成 DAG，显式反馈边定义有次数限制的修订路径。

## 与对话式多智能体系统有什么不同？

对话式编排让 LLM 协调器持续处于执行循环中：

```text
Agent -> Coordinator -> Agent -> Coordinator -> ...
```

Grapher 先编译协作结构，再执行：

```text
目标 -> 图 -> 确定性运行时 -> Agents -> Git -> 结果
```

可检查的调度**不代表模型输出是确定的，也不保证代码质量更高**。单一或线性任务保持串行；不必要的并行可能带来冲突。

## 架构

Rust 后端与 SQLite 事件日志拥有运行状态，React 界面只显示投影。Graph 节点使用独立 Git 仓库；完成边界是成功发布，而不是模型调用结束。

[架构概览](docs/architecture/overview.md)解释动机与不变量；[执行模型](docs/architecture/execution-model.md)解释规划、会话、Git 状态和发布语义。底层运行时、隔离和 Pi 契约从这些页面继续导航，不在首页重复。

## 开发

```sh
npm run check
npm run build
npm run check:docs
npm run test:frontend
npm test                      # Rust 固定样例；无需付费模型
```

集成、平台验证和日志验收见[贡献指南](CONTRIBUTING.md)与[测试指南](docs/development/testing.md)。安全漏洞请按[安全政策](SECURITY.md)报告。无模型测试不能证明服务商效果或全部沙箱边界。

## 文档导航

`docs/` 采用英文作为权威版本，中文 README 保留产品入口。

- [架构](docs/architecture/overview.md)
- [执行模型](docs/architecture/execution-model.md)
- [安装与服务商](docs/guides/installation.md)
- [开发指南](docs/development/contributing.md)
- [Benchmark / Evaluation](docs/benchmarks/harbor.md)

## 许可证

Grapher 原创代码采用 [MIT 许可证](LICENSE)，版权所有 © 2026 Sun Zhe-xu。上游 `pi/` 子模块遵循其自身的 [MIT 许可证和版权声明](pi/LICENSE)；第三方依赖仍遵循各自的许可证。
