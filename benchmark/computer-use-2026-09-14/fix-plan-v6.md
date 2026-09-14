# Fix plan v6：v5 验收、修复与真实 Graph 复测

基线 `56316cd`（包含 v5 修复 `95784ef`），开始时工作区干净。原 v6 草稿引用的 `60376ce` 已过时，本轮按实际源码重新复核。`v6-startup-failure/` 保存首次真实运行的阻断证据；`v6/` 保存修复启动后的基线样本；`v6-final/` 保存同任务/模型/配置的规划改进复测；`v6-contract-recheck/` 保存针对 sandbox 与 feedback 契约的后续规划复核。详细指标、人工质量评价与剩余限制见 [v6 验收报告](report-v6.md)。确定性修复已通过回归；真实 Graph 经一次针对性介入后 completed 并发布。Planner 效率/语义质量仍为部分通过，大快照的长期稳定性仍需更长压力测试，不能把本轮结果写成“所有问题已消失”。

| v5 项 | 验收结论 |
| --- | --- |
| V5-1 旧摘要工作区过滤 | 通过。关联 run 回填与未知归属 fail-closed 已实现，Rust/HTTP 混合工作区覆盖通过。 |
| V5-2 切换项目恢复 | 原实现部分完成；本轮修复异步回写竞态及恢复后被旧节点详情遮住的问题。真实 Chrome 的 A 失败 → B → A → 刷新与受控延迟顺序通过。 |
| V5-3 Graph/UI 质量验收 | 本轮执行真实生产后端、Chrome、Pi 模型及独立最终文件验收；不以 fixture 通过代替效果证据。 |

## V6-1 / P1：统一规划恢复与终态的身份、代次校验

原 App 只在下一次列表查询开始时使旧请求失效，项目检测/切换和新规划终态均可能被旧结果覆盖。新增 `src/services/planningRecovery.ts`，初次加载、选择/添加工作区、新规划开始同步失效旧请求。列表恢复、成功/失败终态及摘要补查统一按工作区、代次、请求编号与规划 ID 校验；取消目录选择恢复原工作区历史。

测试调用实际控制器，不再复制 App 算法。覆盖列表晚于成功/失败、项目切换尚未完成时旧列表返回、补查晚于切换、摘要工作区/ID 不符。真实浏览器延迟实际后端的 list/detect 响应并验证旧卡片不会回写。

## V6-2 / P2：完成真实 Graph 质量、轨迹与时间验收

使用隔离 Git 仓库和独立数据目录，固定 `dashscope/qwen3.8-flash`、四角色 thinking=medium、maxParallel=2、maxFeedback=2；生产后端无 fixture。三类任务分别覆盖已有契约下模块并行、共享契约与双 SDK 反馈审查、独立审计与汇总。按 `agent.md` 第 3–10、13、16、18–21、23–30 节评估交付覆盖、任务自包含、必要依赖、文件归属、并行及 feedback 责任。示例图与节点数量均不是标准答案。

保留 route、最终图、编译器输出、原始 session/工具记录、token、时间、执行事件、浏览器截图和独立验收结果。工具记录中的 `assistantCompletedAt` 与 `resultPersistedAt` 来自 Pi 持久会话，不能冒充网络首 token 或纯模型计算耗时。

## V6-3 / P1：SSE 提前结束不能回退到旧 snapshot

`planGoalStream` 未收到 `complete` 就结束时，原来会调用 `snapshot()`，可能把旧 run 当作本次成功。已改为显式报错。服务级测试断言断流不会读取旧 snapshot。

## V6-4 / P0：Planner 与执行扩展的 bash 注册冲突

首次真实运行三个任务均正确路由 Graph，随后 Planner 在启动时失败：`Tool "bash" conflicts with .../grapher-planner.ts`。`entrypoint.mjs` 对所有角色加载通用 prompt 扩展；v5 的通用扩展注册原生 bash，与 Planner 的受限只读 bash 冲突。

已在通用扩展中隔离角色：Planner/Partitioner 保留 prompt hook，但不注册执行 bash 或其 tool hooks。Node Agent 保留真实退出码包装。扩展 smoke 改为联合加载实际 Planner 与通用扩展（含提取到 runtime 的版本），验证没有冲突、没有 shell 前缀污染，并继续检查 mutation 回滚和只读边界。真实 Planner 重跑已成功。

## V6-5 / P2：规划耗时样式冲突

Chrome 截图发现 Pi 会话耗时显示为蓝色实心块，数值不可见。原因是 `stat-value primary` 同时匹配全局按钮 `.primary` 背景与 padding，文本色也是蓝色。改为专用 `planning-duration` 类；通过构建与真实浏览器复查。

## V6-6 / P2：按实际图质量改进 Planner 契约

首轮图暴露以下问题：节点名含空格被 E201 拒绝；重复报告/验证波次；集成节点同时禁止改源码又条件性要求修源码；把未定义边界变成硬性规则；审计要求在 sandbox 内读取不可访问的 Git 基线；反馈说明把缺陷清单放在 verdict 后；与边界无关的重复仓库检查。

已补充 node.name 工具参数的合法字符说明，并修改规划提示词：明确未定义行为属于解释而非新增硬规则；整合报告与验证；为验证任务指定一致的修复/反馈责任；禁止要求节点访问共享 Git 元数据或未提供的基线；verdict 必须是最后一行；不要为完善实现细节而继续检查无关文件。

这些属于模型行为改进，不能由提示词存在推断已解决。必须以匹配样本检查改善及残留问题；不增加强制节点数量或固定图形等把示例当标准答案的规则。

## V6-7 / P1：恢复最新失败时不能自动展示旧节点详情

真实浏览器发现 A → B → A 后列表接口已返回 A 的最新失败，但 `handleSelectProject` 自动选中旧图第一个节点，GraphWorkbench 的节点详情分支把失败卡片隐藏。恢复控制器发布最新失败时清空自动选中节点，返回全局任务视图。实际 App 回归已通过，证据在 `v6/recovery/result.json`、截图与浏览器 trace。

## V6-8 / P2：共享前置契约不应掩盖中段实质并行

定向复测中双 SDK 样本有一次被 Partitioner 判为 Serial，理由是前置契约与最终共同审查令任务“总体线性”。原分类提示词没有说明并行可以发生在共同前置任务之后。已补充该说明；同任务/模型的后续真实调用返回 Graph，生成四节点共享契约、双实现与反馈审查。保留误判原始输出，单次复测不证明总体路由准确率。

## V6-9 / P1：按真实完成顺序持久化执行状态与时间

真实 Catalog 轨迹发现并行搜索节点的 Pi 已在 174.315 秒退出，但后端等待排在前面的 CSV 节点超时后才记录搜索完成，UI 将其持续显示 RUNNING，记录耗时 600.117 秒。原因是 driver 按派发顺序 `join` 后调用 `runtime.finish`。

已将 `finish` 放在各工作线程执行结束处即时持久化，保留主线程在整波完成后按原顺序处理 review、进入下一调度波次。新增受控快慢节点回归：快节点必须先 DONE 且有 completedAt、慢节点仍 RUNNING、快节点下游仍 WAITING、历史 replay 保留相同结束时间。完整 Rust 45 项与 HTTP/发布回归通过；当前生产后端的真实审计 Graph 已捕获同样的快完成/慢继续状态，见 `v6-e2e/fast-sibling-finished.json` 与截图。

历史执行的错误耗时不做静默改写。验收指标同时给出历史 Runtime 记录耗时与 `grapher_process_exited.elapsedMs`，避免用旧受污染时间评价执行效率。

## V6-10 / P2：审批后的暂停计时也应实时刷新

`PlanningSummaryCard` 的时钟 effect 原来仅在等待审批时运行。执行已获审批后暂停，`pausedSeconds` 使用停留在旧时刻的 now，暂停面板无法实时增长。已将时钟条件改为“等待审批或当前暂停”。真实运行上短暂暂停/继续，面板由 1.7s 增长到 3.7s，当前 Execution Instance 未被停止，证据见 `v6-e2e-recovery/pause-resume-ui.json` 与截图。

## V6-11 / P1：大快照轮询的重复传输与并发请求

真实运行最终达到 completed 且发布成功，但长期打开的 Chrome 在最终 reload 报 Page crashed；快照约 20MB/13,904 条事件。不能仅凭一次崩溃断言唯一根因；重复传输已由响应内容确认，原 setInterval 轮询也缺少在途请求约束，慢响应可能造成请求堆积。

新增显式 `compact` 响应投影，前端请求中去掉已在 executions/mergers transcript 内完整保留的重复 Output 事件，保留全部结构/审批/反馈/介入事件；原始 API 默认响应和 SQLite 历史不变。前端改为上次请求完成后再调度轮询，退出 effect 时取消请求，并显式比较 execution/merger output 长度，保证没有新的结构事件时流式内容也刷新。HTTP 回归核对原始记录未变、compact transcript 完整、bootstrap/history/snapshot 一致。最终大快照刷新、内存采样与受控慢响应检查见 `v6-browser-final/`；有限复测不替代长期压力测试。

## V6-12 / P1：流式轨迹更新与 execution 隔离

检查轨迹组件发现增量解析直接修改旧 item，而 ToolCallCard/ThinkingCard 使用 React.memo，导致内容/工具结束状态可能不刷新；切换到更长的另一次 execution 时仅按输出长度检测重置，会保留旧轨迹并跳过新输出前缀。另有估算行高产生 startIndex 超过总行数、末尾为空的情况。

解析每个新 chunk 时发布新的 item 对象，在 Graph、Sessions、Serial 和 merger 视图按 execution ID 重置 transcript，限制虚拟列表起始位置使末尾始终有内容。真实长轨迹末尾检查与实际 App 的受控流式思考、工具 running→success、长短 execution 切换回归见 `v6-browser-final/result.json`。这些 UI fixture 不计入真实模型图质量成绩。

## V6 补充：规划文字、思维链与工具活动可见性

用户复核发现规划活动在前端缺失。后端原 SSE 已发送 Pi 事件，但文字/思维链受 `isPlanning` 条件限制，完成后被隐藏；工具仅存在内存 state，刷新/历史恢复只加载统计摘要，没有完整日志 API。已保留完成后的实时文字卡片，并在每张规划摘要下增加「查看规划活动」，按需分页加载对应 planning ID 的 Partitioner/Planner JSONL；切换角色/记录会取消旧请求，避免串台。页大小 256KiB、UTF-8 边界及目录越界检查均已覆盖。

真实已完成任务的按需加载、分页、两角色、工具卡片、刷新恢复通过；实际 App 的受控 SSE 回放确认 complete 后文字、思考和工具仍可见。证据见 `v6-follow-up/planning-activity-result.json`。这一恢复针对已落盘阶段；正在运行的规划刷新后重新订阅同次 SSE 仍待实现，列入 [待解决问题](remaining-issues-v6.md)。

本次还生成了[逐节点耗时分析](node-timing-v6.md)，并按[资料索引](README.md)清理重复事件、SSE、中间输出和过时调试记录，保留当前最终完整快照和独立失败样本。

## 自动验证

前端构建、Pi 基线 4 项、规划边界/评分 17 项、Rust fixture 完整套件 45 项（含本机真实 sandbox 3 项及新增完成顺序回归）、UI/回写渲染与生产恢复逻辑 13 项、新构建后端 HTTP 集成、回写 HTTP 套件及联合扩展 smoke 均已运行。最终结果以验收报告及随附日志为准；通过有限测试不表示不存在所有潜在错误。
