# Fix plan v3：对 v2 修复的再次审核

本次只审核当前未提交工作树，未修改实现代码。`npm run build`、UI 静态渲染与 Pi 基线 9 项、Planner/边界 17 项、publication UI 3 项、Pi planner 扩展 smoke、Rust lib/core/engine 31 项通过。**但 `node --check engine/system-prompt.mjs` 失败，当前 worker 扩展无法正常加载；上述测试没有覆盖这个入口。** 现有 `benchmark-results` 最新规划样本为 2026-09-13，早于本轮改动；未见 v2 要求的新版真实模型 Graph 复跑及浏览器交互记录。

## 七项逐项结论

| v2 项 | 结论 | 审核证据 |
| --- | --- | --- |
| V2-1 Planner 停止条件 | 代码语义已修，真实效果未验证 | `backend/resources/planner.ts` 返回 `mutationApplied` / `structuralCheck`；提示词不再把单次修改当整图完成；Pi 扩展 smoke 验证字段。但没有新版真实 Planner 样本证明第一次 mutation 后会继续补全图。 |
| V2-2 验证退出状态 | **未完成，见 V3-1、V3-2** | worker 提示词语法错误阻断启动；tool_result 把输出正文中的 `Command exited with code N` 当真实退出码，并在无数值时合成 0/1。UI 测试手工提供 exitCode，未经过真实 bash→Pi→扩展→事件链路。 |
| V2-3 Planner 质量与延迟 | 未验证 | 未见固定模型/配置、多个不同图任务、固定重复次数及原始失败样本的新版结果。静态评分和旧 benchmark 不能代表本轮。 |
| V2-4 feedback 责任 | 提示词改进，未验证 | 提示词要求 feedback 指向有文件修改责任的节点；Rust fixture 已测协议、上限和局部失效。但没有真实模型 `<REVISE>`→目标重跑→下游重跑→`<ACCEPT>` 样本。 |
| V2-5 规划摘要 | 部分完成，见 V3-3 | UI 改称“Pi 会话耗时”，时间字符串解析增强；成功 run 的摘要可通过 SQLite Created event 恢复。失败摘要仅写 `planning/<id>/summary.json`，`plan_goal` 返回错误后没有 run，也没有列举/读取失败 planning 的 API/UI；失败摘要的 roles 为空，即使 `partition.jsonl`/`planner.jsonl` 已存在。 |
| V2-6 报告边界 | 提示词已修，实际效果未验证 | 删除硬性 50 行上限，要求真实命令/退出码/证据及事实与推断分离；仍缺本轮真实 final verifier 报告，尤其因 V2-2 的退出码来源不可信。 |
| V2-7 真实 UI 回归 | 未完成 | `scripts/ui-regression.test.mjs` 使用 `renderToStaticMarkup` 和预造状态，未在浏览器点击目录保存/审批、刷新历史、观察运行中计时及失败/暂停状态。 |

## 新发现与修复顺序

### V3-1 / P0：修复 worker 提示词语法并纳入启动测试

`engine/system-prompt.mjs:24` 在反引号模板字符串内直接写 `` `npm test` ``、`` `node --test <file>` `` 等未转义反引号，`node --check engine/system-prompt.mjs` 报 `SyntaxError: Unexpected identifier 'npm'`。Pi worker 加载 `engine/prompt-extension.ts` 时导入此文件，因此无法正常启动。转义或移除模板内反引号；在常规测试里加入 `node --check`、真实扩展加载，以及一次最小 worker 启动测试。仅前端 Vite 构建和 planner 专用扩展 smoke 不覆盖它。完成前不要执行或评价新版真实 Graph。

### V3-2 / P1：移除伪造的“结构化退出码”

`engine/prompt-extension.ts:18-32` 从工具**输出正文**搜索 `Command exited with code (\d+)`，并把匹配值写为 `details.exitCode`、甚至改写 `isError`。一个成功的 `printf 'Command exited with code 1\n'` 就会被标记为失败；无匹配的失败一律显示 Exit 1，成功一律 Exit 0，实际进程码可能是其他值或不可知。`VirtualizedTranscript.tsx:253-259`、`App.tsx:724-730` 和 `ToolCallCard.tsx:36-44` 又重复正文解析/默认 0/1，放大误报与误导。`set -e -o pipefail` 可以帮助某些复合命令失败传播，却不能使正文成为权威退出状态，也不能覆盖 Bash 条件/显式忽略失败等语义。

先在 Pi bash 工具/可信执行适配器取得进程 `exitCode` 并作为元数据传递，保留 `null` 表示未知；UI 只展示来源明确的数值，不把正文猜测显示为“Exit N”。若暂时不能取得数值，可只显示 Pi 原生成功/失败状态和“退出码未知”，并要求关键验证命令单独执行。增加真实 bash→Pi→扩展→事件→UI 测试：成功输出中包含 `Command exited with code 1`、静默退出 7、`false | true; true`、真实失败 `npm test`、截断输出，以及未执行/中断状态。当前四例 UI 测试由 mock 直接设定 `exitCode`，不能验证采集链路。

### V3-3 / P2：让失败规划摘要可发现且可对账

`backend/src/server.rs:624-637` 失败时写入空 roles 的磁盘摘要并返回错误；`server.rs` dispatch 无失败 planning 的查询 API，`GraphWorkbench.tsx:432` 只在 `state.planning` 存在时显示卡片，而失败不创建 run。因此 `PlanningSummaryCard` 的“规划未通过”分支当前无法由真实失败路径到达。为 planning ID 提供状态/摘要查询，前端在错误时显示并在重启后可找回；从已经落盘的角色 JSONL 提取部分指标而非丢弃。将 SQLite 与文件的权威性/写入失败语义明确写入 UI；删除“可与磁盘日志完全对账”的无条件断言。覆盖 partitioner 失败、planner 超时、只有部分 JSONL 和服务重启。

### V3-4 / P2：完成 v2 的真实行为验收

修复 V3-1/2 后，固定模型、配置和源码，对独立并行、共享接口、需要反馈的任务做受控规划复跑。记录每次图、工具轨迹、错误、规划耗时、首次无人干预结果及是否需要人工恢复；不能用示例图当标准。至少一个真实 Graph 执行到最终报告以验 V2-4/6，再用 computer use 做 V2-7 所列目录保存、审批、刷新历史和失败/暂停 UI 路径。现阶段这四项仍属于**未验证**，不是测试通过。
