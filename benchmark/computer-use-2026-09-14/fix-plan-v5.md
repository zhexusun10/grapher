# Fix plan v5：v4 修复复核

复核对象为当前未提交的 v4 工作区改动。前端构建、Pi 基线（4 项）、UI 回归（7 项）、Planner 边界/评分（17 项）和新构建后端的 HTTP 集成通过。Rust lib/core/engine/graph merge/publication 的已运行测试通过；`tests/sandbox.rs` 的 3 项因当前宿主禁止嵌套 `sandbox-exec`（`sandbox_apply: Operation not permitted`）未能验收，不将它们记为产品回归。以下判断不把静态或 fixture 测试当作真实模型 Graph 质量证据。

| v4 项 | 复核结果 | 依据 |
| --- | --- | --- |
| V4-1 查询路径 | 通过当前 HTTP 覆盖 | `get_planning` 拒绝带分隔符、点路径和绝对路径的 ID，并检查 canonical 路径；合法失败摘要可读。新 HTTP 测试通过。 |
| V4-2 失败摘要身份与恢复 | 部分完成 | 新摘要有 `createdAt`/`repository`，列表按时间排序，启动新规划清空旧卡片，失败摘要与旧 run 分卡呈现。但旧摘要可绕过仓库过滤，切换项目不会重算失败摘要。 |
| V4-3 Bash 退出码 | 通过当前覆盖 | 每次 `execute` 的 BashOperations 与退出码在调用闭包内；无匹配记录保留 `null`。真实 shell 并发、取消和 orphan 回归通过。 |
| V4-4 真实 Graph/UI 验收 | 尚无新版证据 | 未发现本轮源码对应的固定模型多任务 Planner 轨迹、至少一次真实 Graph 最终报告或 computer use 点击/刷新记录。不能据此判断图质量、耗时或无人干预完成率已经改善。 |

## V5-1 / P1：工作区过滤必须对旧摘要 fail closed

`backend/src/server.rs:list_plannings` 仅在摘要**有** `repository` 且与过滤值不等时跳过；v4 前落盘的摘要经 `serde(default)` 解析为 `repository: None`，因此在任意工作区的过滤查询中仍会返回。此路径在现有 HTTP 测试中未覆盖，因为测试创建的摘要全部带仓库字段。过滤查询应只返回能可靠归属该仓库的摘要；旧记录可通过关联 run 的持久配置迁移/回填，归属不明的记录留在未过滤历史列表，不自动贴到当前工作区。增加混合仓库和缺字段摘要的 HTTP 用例，断言 B 工作区绝不收到 A 或未知归属的失败摘要。

## V5-2 / P1：切换项目后按当前工作区重新选择失败规划

`src/App.tsx:load` 仅在初次挂载查询 `listPlannings`。`handleOpenProject`、`handleSelectProject` 切换仓库与 snapshot 后没有清空或刷新 `failedPlanning`，所以在 A 工作区规划失败后切到 B，B 页面仍显示 A 的失败卡片；切回 A 也不会从持久摘要恢复。抽出带仓库与当前 run 身份的恢复函数，在初次加载及两种切换路径调用；切换前清空旧卡片，给异步响应加仓库/请求序号校验以防旧请求回写。只将当前仓库最近一次**规划尝试**的失败结果自动置顶；若最近尝试成功，旧失败作为历史可查，但不要伪装成当前失败。用真实后端的 A 失败 → B 切换 → A 切回 → 页面刷新、以及“旧 run + 新失败”的浏览器路径验收。

## V5-3 / P2：补齐真实 Graph 质量、轨迹与 UI 验收

沿用 v4 固定模型/配置/源码的三类独立任务（可并行、确需共享契约、确需有界 feedback），每个样本保存 route、graph、compiler diagnostics、Planner 工具调用序列与时间、token、首次完成/修正结果。按 `agent.md` 的原则评估交付覆盖、节点可独立执行性、依赖是否必要、并行与合并边界、feedback 责任和编译有效性；示例图仅供解释，不作为标准答案。至少选一张图经审批执行到最终报告，记录节点执行、feedback 与最终文件证据。随后用 computer use 对测试数据目录检查审批、运行中计时、失败卡、项目切换、刷新恢复。此项是效果验收，不能由现有 fixture 和静态渲染测试替代。
