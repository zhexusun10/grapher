# Fix plan v4：对 v3 修复的复核

`npm run test:pi`（4 项）、`node --test scripts/ui-regression.test.mjs`（7 项）、Planner 边界/评分测试（17 项）、Rust lib/core/engine（31 项）及前端构建通过。另用新构建后端在独立数据目录和端口 1468 验证 API，测试服务已停止。**这些测试不构成新版真实模型 Graph 质量或无人干预完成率证据。**

## V3 各项审核结论

| V3 项 | 结论 | 证据与界限 |
| --- | --- | --- |
| V3-1 worker 提示词语法与加载 | 基本完成 | `node --check engine/system-prompt.mjs` 通过；`npm run test:pi` 增加语法和扩展导入测试。测试只导入扩展，未启动一次真实 worker 会话。 |
| V3-2 退出状态 | 明显改进，仍有设计风险 | `engine/prompt-extension.ts` 从 BashOperations 取得真实 `exitCode`，不再解析 stdout；前端保留 `null` 为未知。真实 shell + 扩展测试覆盖伪造错误文字、退出 7、管道失败和退出 2。但捕获状态的 `pendingExitCode` 是扩展实例共享变量，同批并行 Bash 调用没有调用级隔离；12 个并发样本未复现串线，仍应消除共享状态。无对应记录时成功结果被默认记为 Exit 0，也缺 provenance。 |
| V3-3 失败规划摘要 | 部分完成，存在新问题 | 失败时从已落盘 JSONL 恢复部分角色指标、通过 SSE 返回 summary，新增 `get_planning` / `list_plannings`。但查询路径未校验，已复现目录穿越；有旧 run 时页面不显示新失败摘要；重启后若存在任意 run，则不恢复失败摘要。 |
| V3-4 真实行为验收 | 未完成 | `benchmark-results` 中未发现本轮修改后的固定配置多任务规划/真实 Graph 结果；`ui-regression.test.mjs` 仍是静态渲染加 mock Pi handler，未用 computer use 点击实际设置、审批、刷新及失败路径。真实 feedback 和最终报告质量也未验证。 |

V2-1 的 `mutationApplied` 与 `structuralCheck` 语义在代码和 smoke 中保持正确；本轮仍无真实 Planner 样本验证首次 mutation 后继续补全图。

## 需处理的问题

### V4-1 / P1：限制规划摘要查询路径

`backend/src/server.rs:get_planning` 直接执行 `runtime.root.join("planning").join(&planning_id).join("summary.json")`，未约束 ID。独立后端测试中，请求 `POST /api/get_planning`、body `{"planningId":"../../outside"}` 成功返回测试数据目录外的 `outside/summary.json`（结果的 `planningId` 为 `outside-marker`）。这是确定的只读目录穿越。仅接受规范 UUID 或严格匹配数据目录中的单个子目录名，拒绝 `/`、`\\`、`.`/`..` 与绝对路径；对最终 canonical 路径再检查父目录。增加 HTTP 回归，合法 ID 可读取，穿越 ID 返回错误且不读取目录外文件。

### V4-2 / P1：按当前规划身份显示并恢复失败摘要

`src/App.tsx:load` 只在 `snapshot.runId` 为空时调用 `listPlannings`，有旧 run 时直接清空失败摘要。`GraphWorkbench.tsx` 用 `state.planning || failedPlanning`，旧 run 的成功摘要优先于刚失败的规划；`handlePlanGoal` 开始时也未清理旧 `failedPlanning`。`list_plannings` 用随机 UUID 字符串排序，不能保证最近一次。给 PlanningSummary 记录稳定创建时间和工作区路径/身份；按时间排序并限定当前工作区。开始新规划时清理旧失败状态；本次失败后优先展示本次 planning ID 的摘要，且失败不应伪装成旧 run 的一部分。刷新/重启且存在旧 run 的场景要有可选择失败 planning 的入口。用真实 SSE 错误 + 浏览器刷新测试，而非仅渲染 mock 卡片。

### V4-3 / P2：将退出码捕获改为调用局部状态

`engine/prompt-extension.ts` 的 `pendingExitCode` 由所有 Bash 调用共享；Pi `agent-loop.ts` 默认可并行执行同一消息里的多个工具。当前 12 个并发 shell 调用未出现错误，故列为**潜在竞争风险**，不声称已复现。将 BashOperations 与记录变量封装在每个 toolCallId 的执行闭包内，或由执行操作直接返回 `{result, exitCode}`，使归属不依赖最后写入的全局值。`tool_result` 没有匹配记录时应保留 `exitCode: null` 而非推定 0。加入可控制两个进程完成顺序和结果处理延迟的并发测试、取消/超时测试；保留真实 shell 集成用例。

### V4-4 / P2：完成真实 Graph 和 UI 证据

在 V4-1/2 修复后，用固定模型/配置/源码完成 v3 所列独立并行、共享接口、需要反馈的规划样本，并至少运行一个 Graph 到最终报告。逐次记录图质量、Planner 工具轨迹与耗时、首次无人干预结果、feedback 责任、最终报告证据。再用 computer use 对本地测试目录核对保存目标、审批、运行中计时、失败、刷新恢复。此前样本与静态测试不能替代这批证据。
