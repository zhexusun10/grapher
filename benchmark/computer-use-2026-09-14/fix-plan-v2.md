# Fix plan v2：逐项复核与剩余问题

复核基于当前未提交工作树，与 [v1](fix-plan.md) 逐项对照。检查了 Planner/worker 提示词、Pi 扩展、Rust 运行时、前端和现有回归。`npm run build`、UI 静态渲染回归 7 项、Pi 基线 2 项、Planner 边界/评分回归 17 项、Pi 扩展 smoke、Rust 已运行的 37 项常规测试均通过；受限环境阻止嵌套 `sandbox_apply` 的 3 项测试，以正常宿主权限重跑 sandbox/shadow 4 项通过。**这些是代码回归，不是修复后的真实模型 Graph 复跑。** 未找到固定模型和配置下多个契约任务的新版无人干预运行证据。

## 对 v1 每项的结论

| v1 项 | 结论 | 实际核对 |
| --- | --- | --- |
| 分类失败传播 | 已实现，回归通过 | `backend/src/server.rs` 不再将 `run_pi` 错误转为空分类；失败进程测试检查不创建或审批 run。 |
| 目标目录一致性 | 已实现，自动化覆盖有限 | 保存时重新 detect 并同步元数据，Header 只用匹配路径的元数据；现有 UI 测试只静态渲染 Header，没有通过实际设置弹窗走保存交互。 |
| 执行耗时与状态 | 基本实现 | 历史 attempt 的开始/结束/耗时由持久化时间戳渲染，状态文案按 phase 更新；静态测试只验证已完成执行，尚缺刷新、运行中计时和真实失败态的浏览器回归。 |
| 审批与文档 | 已实现，自动化覆盖有限 | 审批显示实际写回目录，文档同步无工具 Partitioner；弹窗静态测试通过。 |
| P1 执行节点验收边界 | 部分实现 | `engine/system-prompt.mjs` 要求契约忠实、确定性测试、避免测试自证和排查隔离的 Git metadata；但没有修复后真实 worker 样本证明不会再次产生错误断言或超时。 |
| P1 验证命令退出码 | **未完成，见 V2-2** | `engine/prompt-extension.ts` 对包含 `|` 的 bash 命令加 `pipefail`，`ToolCallCard` 根据输出文字猜测隐藏失败。普通末尾成功命令仍能掩盖前面失败，不能保证报告中的 exit code 真实。 |
| P2 Planner 检查效率 | 停止条件已修，效果待测，见 V2-1、V2-3 | 只读语法和停止条件写入 prompt；单次 mutation 与整图完成的语义冲突已改，但未见新版真实模型耗时/错误率数据。 |
| P2 汇合验收与 feedback | 部分实现，见 V2-4 | Prompt 明确 reviewer 的职责、`<ACCEPT>/<REVISE>`、反馈目标；Rust 有协议、上限和局部失效测试，但未用真实模型验证能正确请求修订并稳定完成。 |
| P2 规划摘要持久化与时间 | 部分实现，见 V2-5 | run 的 Created event 持久化 summary，刷新/加载可回放；但“模型执行”的数据是整个 Pi 子进程时长，包含工具、启动和等待，名称和说明不准确；失败的规划不会创建 run 摘要。 |
| P2 最终报告证据边界 | 提示词已加，效果未证实 | 新 Planner prompt 要求简短和证据约束，但限制“50 行以内”是一刀切目标，复杂任务可能需要更多可审查证据；没有真实 final verifier 样本。 |
| 回归与评估方式 | **尚缺真实评估** | 新增的是静态/fixture 回归。v1 要求的固定模型、多个图任务、首次无人干预成功率、规划活动/耗时对比尚未完成。 |

## 待修复项，按优先级

### V2-1 / P0：修复 Planner 提前停止条件（代码已修，待真实复跑）

原实现的每次成功 node/edge mutation 都返回 `accepted: true`，Prompt 又要求看到它就停止。现已将工具结果改为 `mutationApplied: true`、`structuralCheck: "passed"`，明确只表示单次修改通过中间结构校验。Prompt 要求补齐目标、依赖和验收责任后退出，由宿主再做最终编译。**最终结构编译本身也不能证明目标覆盖**，只有一个节点的图仍可能通过，因此不能用 `graphCompiled: true` 作为唯一停止条件。Pi 扩展 smoke 已新增首次 mutation 语义断言；真实模型是否在第一次 mutation 后继续构图仍待受控 Graph 复跑验证。

### V2-2 / P1：对验证结果提供结构化退出状态

`engine/prompt-extension.ts:9-10` 的 `command.includes('|')` 只能覆盖部分 pipeline；`set -o pipefail; false | true; true` 仍退出 0。包含字符串 `pipefail` 时甚至跳过注入。`src/components/ToolCallCard.tsx:37-49` 识别 `FAIL`/`AssertionError` 是启发式 UI 提示，既可能误报，也可能漏报安静失败；不能代替退出码。不要依赖命令字符串改写来保证结果。为关键验证命令保存并显示实际退出码、命令及完整/截断标志；对多命令或管道明确每个待验证步骤的状态。无法可靠解析时要求单独执行验证命令。用 `false | true; true`、静默失败、输出含单词 `FAIL` 但退出 0、真实 `npm test` 失败四例验证，不得报告全绿。

### V2-3 / P1：实测 Planner 质量与延迟

Prompt 指南没有真实模型效果证据。固定模型、thinking、并发和源代码版本，对至少三个不同任务（独立并行、共享接口、需要独立反馈）各做固定次数的规划；逐次保留 route、图、工具开始/结束、编译诊断、时间和原始失败。评估契约覆盖、合理依赖、可合并性、有效验收及反馈路径；分别报 Partitioner、Planner、审批等待和 worker 时间。不要只报平均数或只保留成功图，也不要以 v1 的示例图作标准。

### V2-4 / P2：验证 feedback 责任在实际图中可执行

新提示词要求 reviewer 只验收并把 `<REVISE>` 指向可修改缺陷的 Target，这个约束合理；但如果缺陷在两个并行实现分支而 reviewer 仅连到汇合节点，返工目标可能无实际文件所有权。增加图级检查或人工 rubric：每个反馈目标能够访问并修改需返工文件，反馈后汇合测试会重跑。用一例真实模型故意可修订缺陷验证 `<REVISE>`→目标重跑→下游重跑→`<ACCEPT>`；同时验证上限和无关分支不被重跑。不要硬编码节点数。

### V2-5 / P2：修正规划摘要口径与失败态

`backend/src/server.rs:369-372,575-587` 用 `grapher_process_exited.elapsedMs` 汇总为 `model_duration`，`PlanningSummaryCard` 展示为“模型执行”“纯计算执行耗时”。这个跨度实际包含模型调用、工具执行和进程开销；应标为“Pi 会话耗时”或分开计量。`sessionStart`/`lastEvent` 可能是 epoch 毫秒字符串，前端 fallback 用 `new Date(string)` 不能稳健解析。成功 run 的 summary 在 SQLite Created event 中可回放，`summary.json` 写入却忽略错误，而界面宣称可与磁盘日志“完全对账”；规划失败则没有对应 run 摘要。统一时间格式与来源，记录 summary 写入失败或明确 SQLite 才是权威；为失败 planning ID 保留可查看状态/耗时。用真实 JSONL 对账测试，涵盖缺失 process-exited、失败/超时、重启后读取。

### V2-6 / P2：让报告约束适配任务复杂度

`backend/resources/prompts/planner.md:49-51` 的“under 50 lines”可能压掉重要复现信息。改成以结论、命令、退出码、测试计数和证据链接为核心的简洁要求，允许复杂任务有必要的详表。报告应明确“已观察事实”和“推断”，原始契约与额外实现行为分开；静态检查不能证明“无网络”。用真实 Graph 的最终报告验收长度和证据可追溯性。

### V2-7 / P2：补真实 UI 回归

`scripts/ui-regression.test.mjs` 是服务端静态渲染，验证了文字和纯函数，但没有点击设置保存、刷新历史快照、运行时计时或审批后写回。对本地测试目录用浏览器完成：切换目录→保存→标题/目标一致；Graph 审批文案显示目标；刷新与重启后历史 attempt 时间一致；失败和暂停 footer 正确。把结果及环境记入回归记录。

## 完成判据

V2-1 的代码修改已完成；先解决 V2-2，再做 V2-3 的受控真实 Graph 复跑并验证 V2-1 效果。V2-4 至 V2-7 可随后推进。每次复跑分别统计首次无人干预结果与人工恢复结果，保留所有失败样本。不要把静态测试通过写成 Planner 图质量已经改善。
