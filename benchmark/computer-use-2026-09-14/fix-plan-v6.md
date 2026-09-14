# Fix plan v6：v5 修复复核

复核提交 `60376ce`，工作区干净。前端构建、Pi 基线 4 项、UI 回归 8 项、Planner 边界/评分 17 项、Rust lib 5 项和新构建后端的 HTTP 集成通过。当前 in-app browser 的旧标签页显示“页面崩溃”，它指向此前的 `127.0.0.1:1457`，不能据此判断本次构建的 UI 行为；本轮未完成真实浏览器操作验收。

| v5 项 | 结论 | 依据 |
| --- | --- | --- |
| V5-1 旧摘要工作区过滤 | 通过当前覆盖 | 有关联 run 的旧摘要从 Created 事件回填仓库；无归属摘要在带仓库过滤时被排除。Rust 和 HTTP 混合仓库测试通过。 |
| V5-2 切换项目恢复失败摘要 | 部分完成 | 初次加载与两种切换路径都会查询，最近成功规划不会被旧失败冒充；但请求失效只发生于下一次查询开始，直接设置失败/成功状态的路径没有使旧请求失效。新增 UI 测试复制了 App 中的状态逻辑，未挂载真实 App 或点击浏览器。 |
| V5-3 真实 Graph/UI 质量验收 | 未完成 | 此提交只有源码和 fixture/mock 测试；没有与 `60376ce` 对应的新模型/配置/源码锁定的三类 Graph 样本、Planner 工具轨迹与时间、最终报告或 computer use 操作记录。因此 Planner 图质量与首次无人干预完成率仍不可下结论。 |

## V6-1 / P1：所有规划状态变更都应使旧摘要请求失效

`src/App.tsx:refreshFailedPlanning` 仅在函数调用开始时递增 `planningRequestIdRef`。`handleOpenProject` / `handleSelectProject` 在等待 picker、detect、reset/load 的过程中只调用 `setFailedPlanning(null)`，旧仓库的查询仍可先完成并回写；`handlePlanGoal` 开始、SSE `complete`/`error` 以及最终 `catch` 直接清空或设置失败摘要，也没有失效此前在途的 `listPlannings` 查询。特别是“旧失败摘要查询在途 → 新规划成功并清空卡片 → 旧响应到达”会重新显示过期失败；`getPlanning(...).then(setFailedPlanning)` 在项目切换后也可能回写别的工作区结果。

切换工作区或开始新规划时立即失效旧请求；成功、失败终态和异步 `getPlanning` 补查都以当前仓库、规划 ID 与请求代次核对后再写状态。把恢复逻辑作为可直接测试的函数/Hook，而不是在测试文件里重写一份算法。增加受控延迟测试，覆盖旧列表响应晚于新规划 `complete`/`error`、补查晚于项目切换、A→B 切换期间旧响应先到的顺序，并挂载 App 或通过浏览器验证展示结果。

## V6-2 / P2：实际完成 v5 的 Graph 与浏览器效果验收

在隔离测试目录运行固定模型/配置/源码的可并行、确需共享契约、确需有界 feedback 三类真实规划；保存 route、最终图、编译诊断、每次 Planner mutation/反馈、耗时和 token。按 `agent.md` 的交付覆盖、节点独立性、必要依赖、合并边界和反馈责任评估图；示例图不作标准答案。至少一张图审批后运行到最终报告，核对文件证据、feedback、节点时间与首次完成结果。再用 computer use 对当前构建检查审批、计时、失败、项目切换及刷新恢复，保存可复查的操作记录。fixture HTTP 与静态渲染通过不能替代这些证据。
