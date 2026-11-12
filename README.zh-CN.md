<p align="center">
  <img src="assets/icon-dots.svg" width="80" height="80" alt="Grapher 标志">
</p>

<h1 align="center">Grapher</h1>

<p align="center">
  <strong>不编排智能体，编译工作。</strong><br>
  告别“转述失真”。
</p>

<p align="center">
  将复杂工作编译为可检查执行图的本地 Coding Agent 工作台。<br>
  基于 <a href="https://github.com/earendil-works/pi">Pi</a> 构建
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#工作方式">工作方式</a> ·
  <a href="docs/user-guide.md">使用指南</a> ·
  <a href="README.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/zhexusun10/grapher/actions/workflows/planner-source.yml"><img src="https://github.com/zhexusun10/grapher/actions/workflows/planner-source.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT 许可证"></a>
  <a href="https://www.rust-lang.org/"><img src="https://img.shields.io/badge/rust-stable-orange.svg" alt="Rust stable"></a>
</p>

<p align="center">
  <img src="assets/readme-graph-zh.png" width="100%" alt="Grapher 工作台：视频检测研究任务被规划为等待批准的 21 节点执行图">
  <br><sub>从复杂目标到可检查的 21 节点执行图，直观呈现并行分支、依赖拓扑与有界反馈。</sub>
</p>

## 典型多智能体系统 vs Grapher

```text
典型多智能体系统

目标 → 主管 LLM → Agent → 主管 LLM → Agent → ...
          ↑ 调度存在于对话循环内部


Grapher

目标 → Planner → 编译后的执行图 → 确定性 Runtime
                                      ├── Agent A ──┐
                                      ├── Agent B ──┼──→ Agent D
                                      └── Agent C ──┘
```

**核心区别：**

1. **执行循环中没有主管** — LLM 规划执行图后退出调度器。
2. **彻底告别转述失真（Zero Conversational Message Passing，绝无 Lost in Translation）** — 传统多 Agent 系统依赖密集的 Agent 间对话，技术约束与设计细节在层层“传话筒”汇报中极易衰减和失真。Grapher 在节点间完全杜绝对话消息传递，任务间继承的是确定性的 Git 代码状态与文件历史，而不是容易产生幻觉的聊天记录。
3. **执行图就是可执行状态** — 依赖、重试、反馈和发布都是明确的运行时状态转换。
4. **没有预定义 Agent 角色** — 所有节点运行通用 Coding Agent；专业化来自任务上下文，而不是硬编码角色。

## 为什么选择 Grapher？

- **集成式 Coding Agent 工作台** — 在同一个界面中与 Coding Agent 对话、管理服务商认证与各角色模型设置、查看工具调用、日志和文件变更，并随时进行干预。
- **确定性编排** — 调度、依赖、结果失效、重试和有界反馈是明确的 Rust 状态转换。我们不向模型注入 prior bias；模型使用层与系统编排层解耦，让模型保持灵活通用：确定性、系统性规则由 runtime/harness 负责，而不是靠 prompt 向模型暴露系统细节。
- **工作区继承（传递代码，而非闲聊）** — 子节点直接继承父节点的 Git 提交历史以及包含 `.gitignore` 在内的完整项目文件状态。节点之间绝不互相“对齐聊天”，彻底避免技术细节在多轮转述中失真（Lost in translation）；每个 Agent 的上下文保持干净专注，代码的交接与冲突由 Git 机制精确处理。小批次共用源目录、实时共享文件；较大的并行批次使用独立工作区，结果合并写回后才启动下一批。
- **可检查的执行图与闭环迭代** — 在 UI 中查看依赖、并行分支和有界返工。自动批准和任务后 Planner 复盘默认开启，支持多轮自主迭代（Loop Engineering）；关闭自动批准可在执行前逐图审核。
- **本地优先** — 在你的机器上运行，并在宣告完成前把有效的 Graph 结果发布回代码库。模型请求仍会发送给你配置的服务商。

<details>
<summary><strong>查看旧版界面中的 16 节点实际完成记录</strong></summary>
<p align="center">
  <img src="assets/execution-graph-zh.png" width="100%" alt="旧版 Grapher 界面：机器学习任务的 16 个节点均显示已完成">
  <br><sub>真实 Grapher 界面，展示复杂机器学习任务编译生成的 16 节点执行拓扑图与全流程完成记录。</sub>
</p>
</details>

## 什么时候应该使用 Grapher？

<p align="center">
  <img src="assets/readme-home-zh.png" width="100%" alt="Grapher 首页：输入视频检测研究目标，并可选择 Auto、Serial 或 Graph 模式">
  <br><sub>从一个目标出发，选择适合当前任务的执行路线：Auto、Serial 或 Graph。</sub>
</p>

**Agent 并不是越多越好。** Grapher 最适合包含独立工作流的编程任务，例如：

- 前端 + 后端修改
- 实现 + 测试
- 天然包含多个独立模块（特征工程、训练、评估）的机器学习与研究任务
- 实现后进行有界审查 / 返工

小型、线性或高度耦合的任务应使用 **Serial**。只有当显式依赖和独立工作流值得拆图时才使用 **Graph**；**Auto** 让 Partitioner 选择路线。

| | Serial | Graph |
| --- | --- | --- |
| 适合任务 | 小型 / 线性任务 | 独立工作流 |
| 编程 Agent | 一个 | 一个或多个任务节点 |
| 规划 | 直接执行 | 编译执行图 |
| 审批 | 自动 | 默认自动批准，可改为手动审批 |
| 工作区 | 用户项目 | 逐批选择：实际派发节点 ≤2 时共用源目录，>2 时使用独立工作区 |
| 调度 | 顺序执行 | 依赖感知、有界并行 |

**Settings → Harness设置**中的五个选项默认全部开启，已保存的关闭选择保持不变。关闭**隐藏 Auto 模式**即可显示 Auto 和 Partitioner 模型配置。

按每个实际派发批次判断：节点 ≤2 时共用源目录，>2 时启用独立工作区。上一批结束并完成结果交接后再启动下一批；后续小批次会回到源目录，Planner 复盘新增任务也遵循同一规则。**Settings → Harness设置**可为新对话关闭隔离。共享可减少环境准备和合并成本，但并发修改同一文件可能互相覆盖。

规划副作用、操作控制与恢复方式见[使用指南](docs/user-guide.md)。Graph 是执行路线，不是 Agent 数量下限；图也可以只有一个节点。

## 快速开始

**依赖：** Node.js 22.19+、稳定版 Rust、Git、npm、网络和服务商认证。Windows 需要 Git for Windows Bash；macOS 需要 Xcode Command Line Tools（用于 Rust 链接），Graph 独立工作区使用系统内置 Seatbelt 沙箱；Linux Graph 独立工作区需要 bubblewrap，并允许非特权 user/mount/PID namespace。

**不想安装编译工具？** 直接下载可运行的[发布包](https://github.com/zhexusun10/grapher/releases/latest)：校验 `.sha256` 后解压，运行 `start.bat`（Windows）或 `./start.sh`（macOS/Linux）。发布包在运行时仍需要 Node.js 22.19+ 与 Git；无需 Rust 和 npm。

```sh
git clone --recurse-submodules https://github.com/zhexusun10/grapher.git
cd grapher
npm run dev
```

`npm run dev` 会自动检查环境工具、初始化子模块、安装锁定依赖并编译后端。也可手动执行 `npm ci --ignore-scripts` 与 `npm run pi:setup` 分步准备。

打开 **<http://127.0.0.1:1420>**。首次启动可能需要等待 Cargo 编译。macOS 上后端运行期间会保持显示器和系统唤醒，避免长时间任务因空闲睡眠或屏幕保护锁定而中断；设置 `GRAPHER_KEEP_AWAKE=0` 可关闭。

1. 在**设置**中选择本机项目，完成服务商认证并选择 `provider/model`。也可通过 `npm run pi` 登录。
2. 输入编程目标。选择 **Serial** 使用单个 Pi Agent，选择 **Graph** 规划任务图。如需让 Partitioner 判断路线，可在 Harness设置中显示 **Auto**。
3. Graph 默认自动批准并开始执行；如需先查看并**批准**计划，请在提交前关闭 **Auto Approve**。执行中可查看节点日志、暂停正在运行的节点并稍后继续原会话，或追加指令。
4. 独立工作区的有效结果成功发布回项目后才算完成；共享模式直接修改源项目，无需单独发布。发布失败会保留状态供检查或重试。

**只在可信项目上使用，首次体验建议用可丢弃的项目。** Planner 的 Bash 写入会在审批前直接修改源项目，规划失败或取消也不会回滚；Git 快照会强制收集项目文件，Runtime/环境内部目录除外。拒绝计划不等于回滚。Windows 工作区不是文件系统沙箱。在重要代码上运行前，请阅读[审批前须知](docs/user-guide.md#before-you-approve)和[文件系统边界](docs/architecture/filesystem-isolation.md)。

已有克隆仓库请先运行 `git submodule update --init --recursive`。Pi 是锁定版本，不会使用全局 Pi 替代。

本机生产模式：

```sh
npm run build
npm start
```

打开 <http://127.0.0.1:1421>。

## 工作方式

```text
编程目标
    |
    v
Partitioner
    |-- 简单 / 线性任务 --> Serial Agent --> 用户项目
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
                      |               |
                   Agent A         Agent B
                      \               /
                      工作区继承
                                |
                                v
                             Agent C
                                |
                                v
                          发布到项目
```

模型负责拆分工作并执行具体任务，编译器负责验证图。编译完成后，Planner 可以退出：调度不再依赖协调器的下一条消息。普通依赖构成 DAG：子节点在父节点完成后运行，并继承父节点的 Git 历史以及完整项目文件状态，包括匹配 `.gitignore` 的路径。已应用的反馈会向固定目标发送有界返工指令，并把发送方已完成的工作区交给目标；目标继续自己的对话。独立工作区通过 Git 快照交接项目输出，共享模式则直接使用实时文件；节点之间绝不交换对话上下文，确保技术意图与代码真实状态永远不会在多 Agent 传话中失真（Never lost in translation）。

开启**任务后 Planner 复盘**（Post-task Planner review）后，当图任务全部执行完毕并交付结果后（发布写回或直接修改源项目），系统会自动唤起 Planner 审查最新状态并自主决定下一步行动——包括审核工作区、制定新计划/派发新节点、向用户汇报结果或完成收尾工作等，不做人工限制。整个流程始终严格遵循节点间无 message 传递的核心设计（通过 Git 工作区状态继承而非会话传递）。配合**自动批准（Auto Approve）**，可形成鲁棒的 Loop Engineering 自主迭代闭环。

## 架构

**模型负责编码，Runtime 负责流程。** Grapher 将依赖、有界返工与交付显式化，而不是把调度交给另一段对话。你可以检查计划、在执行中干预，并确认结果确实写回项目。

日常操作请阅读[使用指南](docs/user-guide.md)。如果要开发或修改 Grapher，请从[开发者架构文档](docs/architecture/overview.md)了解组件边界与各专题的唯一契约。

## 开发

```sh
npm run check
npm run build
npm run test:frontend
npm run test:backend          # Rust 固定样例；无需付费模型
```

集成、平台验证和日志验收见[贡献指南](CONTRIBUTING.md)与[测试指南](docs/development/testing.md)。安全漏洞请按[安全政策](SECURITY.md)报告。无模型测试不能证明服务商效果或全部沙箱边界。

## 文档导航

**使用 Grapher：** [使用指南](docs/user-guide.md) · [安全政策](SECURITY.md)。

**开发 Grapher：** [架构契约](docs/architecture/overview.md) · [贡献指南](CONTRIBUTING.md) · [Benchmark / Evaluation](docs/benchmarks/harbor.md)。

[文档索引](docs/index.md)区分用户指南与开发者任务路由。Coding Agent 应使用 [AGENTS.md](AGENTS.md) 了解仓库约束。

## 许可证

Grapher 原创代码采用 [MIT 许可证](LICENSE)，版权所有 © 2026 Sun Zhe-xu。上游 `pi/` 子模块遵循其自身的 [MIT 许可证和版权声明](pi/LICENSE)；第三方依赖仍遵循各自的许可证。
