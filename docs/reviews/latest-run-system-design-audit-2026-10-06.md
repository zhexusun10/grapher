# Graph 运行记录与系统设计历史审计（2026-10-06）

> **Status:** archived
> **Scope:** 审查时的运行证据与建议；当前执行合同见下方警告中的链接。

> **历史快照，不是当前执行合同。** 下文保留审查时的运行事实、实现状态与建议。工作区继承相关结论已被后续实现取代；当前行为以[执行模型](../architecture/execution-model.md)和[工作区快照与反馈](../architecture/workspace-snapshots-and-feedback.md)为准。
>
> - 普通依赖与已应用的 feedback 都继承 Git 文件和版本化 ignored 项目资源，并可独占交接已完成的物理目录；并行分支独立可写，节点对话不互相继承。
> - feedback 目标可读取发送方已完成的报告、缓存等项目文件，并继续自己的历史；“feedback 只传文字、不传文件”及其 instruction-only 前置提示建议不再适用。
> - 反馈请求持久化完成结果与最终正文的日志字节范围，转发正文去掉最终控制标记。预算耗尽不会转交工作区、发送返工指令或把跳过的反馈正文注入普通下游任务。
> - 共享终端工作区中的追加消息更新当前合并状态，不要求重跑已完成下游；历史消息编辑和已应用反馈仍保留各自的失效规则。文件继承也不保证任意虚拟环境可重定位。

> 审查范围：最新一次本地 planning 记录、最终 Graph、当前工作区中的 Planner/Runtime/Workspace 合同，以及现有反馈验证日志。
>
> 本次只新增本审计文档；没有修改实现、提示词、Graph、运行记录或现有文档。审查开始时工作区已经存在大量未提交改动，本报告将这些改动视为待评审内容，不把它们当成已经发布的行为。

## 1. 审查对象与运行结论

### 1.1 最新一次记录

| 项目 | 结果 |
| --- | --- |
| Run ID | `9eb044d6-299d-407c-b2f0-289b9e40152b` |
| Planning ID | `9c1a8182-eeb9-4e72-b525-07dcf782cf95` |
| 记录目录 | `.grapher/planning/9c1a8182-eeb9-4e72-b525-07dcf782cf95/` |
| 规划结果 | `success` |
| 规划耗时 | 约 650.6 秒 |
| Planner | 7 条 assistant 消息、7 次工具调用、1 次工具错误 |
| 最终 Graph | 17 个节点、30 条边、3 条 feedback 边 |
| 目标仓库 | `C:\Users\孙哲徐\Desktop\DEMO` |

这次记录**只完成了规划，没有开始 Graph 执行**。`events.sqlite` 中可见的是 `planning_started`、`routed`、`created`、`routed`，没有 `Approved`、`Started`、`Finished` 或最终发布事件。因此，`summary.json` 中的 `success` 只能解释为“规划成功”，不能解释为“项目执行成功”或“指标达标”。

### 1.2 本次规划出的反馈结构

最终 Graph 中有三条反馈回路：

| 普通依赖 | feedback 方向 | 反馈目标 | 反馈会使其重算的普通依赖范围 |
| --- | --- | --- | --- |
| `official_data_pipeline -> data_leakage_audit` | `data_leakage_audit -> official_data_pipeline` | `official_data_pipeline` | 8 个节点，包含后续 GPU、优化、评估和交付链路 |
| `gpu_development_experiments -> metric_optimization_review` | `metric_optimization_review -> gpu_development_experiments` | `gpu_development_experiments` | 5 个节点 |
| `calibrate_final_evaluate -> report_cards_presentation -> delivery_acceptance` | `delivery_acceptance -> calibrate_final_evaluate` | `calibrate_final_evaluate` | 3 个节点 |

三条 feedback 边都满足“反馈发送方是目标的普通依赖后代”这一结构约束，Graph 的普通依赖图也没有发现明显的环。这部分规划是合理的。

### 1.3 运行前置检查暴露出的事实

Planner 在空的 `DEMO` 目录中做了环境探测：

- `nvidia-smi` 能看到 RTX 5080，约 16 GB 显存，驱动版本为 617.14。
- 系统 Python 为 3.14.6，`torch` 尚未安装。
- 探测命令最后执行 `git status --short`，因为 `DEMO` 还不是 Git 仓库，整次 Bash 调用被标记为错误；这掩盖了前面已经成功获得的 GPU 信息。
- 探测输出中没有 `ffmpeg`/`ffprobe` 的可用路径。

这不是 Planner 失败，但说明“环境能力”目前依靠模型解读一段 shell 输出，且一个无关的最后命令可以把整次探测变成工具错误。后文将把它列为系统设计改进项。

## 2. 对当前问题的直接结论

**是的，应该在 feedback 相关提示词中明确写出这一点；但不能只在 `official_data_pipeline` 的任务中写。**

当前代码和 Planner 工具合同其实已经部分说明了该规则：

- `backend/resources/planner.ts` 的 `edge` 工具描述写了：普通依赖边传递 filesystem state，feedback 边不提供 filesystem input。
- `docs/architecture/execution-model.md` 和 `docs/architecture/runtime.md` 描述了独立工作区、普通依赖快照和反馈边的区别。

但是这些内容主要给 **Planner** 看。真正收到 feedback 的 Node Agent 并没有一个统一、运行时注入的“反馈通道说明”。普通 feedback 的运行路径目前是把发送方的最终文本作为一条后续消息交给目标节点；模型很容易把“反馈文本”误解成“发送方已经生成了可供我读取的文件”，尤其是本次 Graph 中的审计报告、特征缓存、checkpoint、模型权重等都很像文件型产物。

因此，`official_data_pipeline` 中的这句属于正确的局部防护，但应该升级为全局协议：

1. Planner 在设计 feedback 边时必须看到该协议。
2. 发送 feedback 的节点必须被要求把所有可执行事实写进最终反馈正文，而不是只写“请查看某个文件”。
3. 接收 feedback 的节点应该由 Runtime 自动获得一段不可遗漏的系统/任务前置说明，而不是完全依赖 Planner 是否把句子复制到节点任务。
4. `metric_optimization_review -> gpu_development_experiments` 和 `delivery_acceptance -> calibrate_final_evaluate` 也必须遵循同一协议。

## 3. 应明确的三种数据通道

目前最容易混淆的是“普通依赖”“feedback”和“预算耗尽后的特殊转发”。建议把下面的表作为系统的唯一语义基线：

| 通道 | 接收方得到什么 | 接收方得不到什么 | 工作区/会话行为 |
| --- | --- | --- | --- |
| 普通依赖 `A -> B` | A 完成后可被记录的 workspace snapshot；多个普通父节点会合并 | A 的对话、实时工作区、未记录的 ignored 文件；`relation` 不是文件白名单 | B 使用自己的新会话和工作区 |
| Feedback `B -> A` | 一条额外的文字指令 | B 的文件、commit、workspace、附件、对话上下文 | A 继续自己的既有 session/workspace；不读取 B 的工作区 |
| Feedback 预算耗尽后的特殊上下文 | 计划中的实现会把 B 的最终反馈正文作为 direct ordinary consumer 的任务上下文 | B 的对话和文件；不应包含 `<FEEDBACK>` 控制标记 | 不重做 A；普通下游继续执行 |

特别要强调：

- `data_leakage_audit -> official_data_pipeline` 这个 feedback 边不会把 `data_leakage_audit` 工作区里的 `reports/data_audit.json` 传回去。
- `official_data_pipeline -> data_leakage_audit` 这个普通依赖边才会把前者的可继承文件快照传给后者。
- 如果审计节点只把发现写进文件、反馈正文只写“见 `reports/data_audit.json`”，目标节点就无法可靠修复。
- 普通依赖也不是 live directory 共享；节点只接收已记录的快照。ignored/untracked 依赖（典型如 `.venv`、大型 raw data、feature cache、模型权重）不会因为普通依赖边自动传来。

## 4. 发现的问题与优化建议

### P0-1：反馈通道合同分散，Node Agent 没有确定性提示

**证据**：Planner 工具描述已经有“feedback 不传文件”，但 `backend/src/engine.rs` 给 feedback source 的追加提示目前主要是 `<ACCEPT>/<FEEDBACK>` 格式；目标节点收到的是发送方文本，缺少统一的“这是 instruction-only channel”前置说明。

**风险**：模型会把反馈发送方生成的报告、checkpoint、缓存文件当作可见输入；或者只在发送方工作区写报告而不在反馈正文中复述关键结论。当前 Graph 的三个反馈回路都有这个风险。

**建议**：Runtime 在每次普通 feedback 传递时自动加前置说明，至少包含：发送方、目标方、feedback 边不传文件、目标继续自己的工作区和会话、所有修复必须在目标工作区完成。不要让 Planner 是否记得复制一句话成为正确性的前提。

### P0-2：`.venv`、raw data、feature cache 和权重的传递假设不安全

**证据**：本次节点任务多次提到 `.venv`、`data/raw`、`artifacts/features`、checkpoint、模型 bundle 和共享 cache。当前执行模型明确规定 ignored/untracked 依赖不会自动进入下游快照；工作区也不是 live 共享目录。

**风险**：上游节点可能“成功”创建了 `.venv` 或大文件，但下游新工作区看不到它们；模型随后可能使用系统 Python/CPU、重新下载、创建另一份 cache，或生成看似成功但不可复现的结果。这个问题与 feedback 文件不传是同一类“隐含输入合同”问题。

**建议**：不要把虚拟环境和大型数据当作普通 workspace 输出。选择一种显式机制：

- 每个节点根据 tracked lock/config 在本节点 bootstrap 自己的环境；或
- 使用项目外的、内容寻址的只读依赖/数据 cache，由 Runtime 注入并记录 lease、hash 和版本；或
- 增加显式 artifact store，节点只通过 manifest、hash 和 materialize 动作交换大文件。

Planner 的节点任务应明确写出 `required inputs`、`materialized artifacts` 和 `bootstrap command`，而不是只写“上游已经准备好了”。


### P1-1：任务要求“至多 2 次”，系统配置却是全局 3 次

**证据**：`official_data_pipeline` 的任务要求至多 2 次明确修复；`delivery_acceptance` 也有两次修复语义；当前 `.grapher/config.json` 的 `maxFeedback` 为 3，Runtime 以全局配置为反馈预算。其他优化节点又要求最多 3 轮。

**风险**：自然语言中的次数限制不会被执行器强制执行；同一 Graph 中不同 feedback 边也无法拥有不同预算。模型可能收到第三次反馈，或者 UI/日志显示的次数与任务合同不一致。

**建议**：把预算放进 feedback edge 的结构化字段，例如 `maxFeedback`，并在事件中记录 effective limit。全局配置只作为上限。编译器应校验 `maxFeedback` 范围，Runtime、UI、提示词和 `FeedbackExhausted` 都使用同一个边级值。

### P1-2：普通 feedback 的正文仍混入控制标记，且可能重复大段日志

**证据**：当前普通反馈路径将 `Feedback from {from}:\n{output}` 作为目标 instruction；`output` 仍包含最终 `<FEEDBACK>` 标记。相比之下，工作区中的未提交改动已经为 `FeedbackExhausted` 设计了 log byte range，并在转发时去掉标记，但普通 feedback 尚未完全采用同一模型。

**风险**：目标节点可能把上游的 `<FEEDBACK>` 当成自己的协议指令；大段反馈正文还会复制到 Invalidated event 和 node state，增加事件/快照体积。只写文件不写正文的问题也没有被结构化识别。

**建议**：反馈应分成两部分：

- 控制层：`accepted`、`source`、`target`、`feedback_id`、`attempt`、`limit`；
- 内容层：去掉 `<FEEDBACK>` 的 actionable instruction，最好包含 `path/issue/expected/acceptance`。

长正文应以 execution log 的 `(execution_id, offset, bytes)` 引用为主，在创建目标任务时按需读取；反馈正文为空、只有控制标记或只说“见文件”时应告警或拒绝。

### P1-3：`relation` 容易被误解成文件过滤器，fan-in 也没有输出所有权

**证据**：本次 Graph 有多个 fan-in：`official_data_pipeline` 有两个普通父节点，`experiment_orchestrator` 有五个，`local_mvp` 有五个，`integrate_cache_gpu` 有三个。当前 `relation` 只是描述文字，不会限制传递哪些路径；多个父节点的 filesystem state 会合并，冲突时才启动 Merger。

**风险**：Planner 可能认为 relation 只会传递“manifest/split”或“feature interface”，实际却可能带来父节点全部可记录变更；不同父节点还可能同时写 `docs/`、`configs/`、`src/aivdetect/__init__.py` 或环境文件，造成冲突或隐藏覆盖。

**建议**：短期在 Planner 合同中明确“relation 不是路径白名单，普通边传递整个可继承快照”。中期为节点增加 `outputs`/`inputs` 声明和路径所有权检查；发现两个并行父节点拥有相同输出路径时，在规划阶段给出警告，必要时引入专门的集成节点。



### P1-5：反馈发送方的“文件事实”没有强制转成反馈正文

**证据**：`data_leakage_audit` 会写 `reports/data_audit.json`，`metric_optimization_review` 会写 selection/review 文件，`delivery_acceptance` 会写验收文件；这些节点的 feedback 目标分别是上游节点，feedback 边不能把这些文件传回目标。

**风险**：目标收到的只是摘要，或者摘要引用了目标看不到的路径。修复会遗漏具体 video/group ID、期望值、失败原因或 acceptance criteria。

**建议**：所有带 feedback 出口的节点任务增加“发送反馈前必须在最终正文列出完整可执行事实”的合同，至少包括：

- 受影响的文件/manifest/ID；
- 观察到的值与期望值；
- 泄漏/失败/指标问题的具体原因；
- 修复完成的判定条件；
- 需要目标节点重新运行的命令或检查。

报告文件仍可保留给其普通下游，但不能作为 feedback 目标的唯一信息来源。



### P2-2：环境探测和计划完成状态需要结构化

本次 shell 探测因为空目录中的 `git status` 返回非零而被标记为 tool error；同时规划成功后没有执行。建议增加内置 `capabilities/preflight` 工具，返回 JSON：`gpu.available`、`torch.cuda`、`ffmpeg`、`git`、`disk`、`data_source`、`python` 及每项的 `ok/blocked/reason`，避免用一串 `;` 命令让最后一个探测影响全部结果。

UI、Run summary 和 API 还应区分：

- planning succeeded；
- awaiting approval；
- execution blocked；
- execution completed；
- publication completed。

不能用 planning 的 `success` 让用户误以为模型指标已经完成。



