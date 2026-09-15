# v6 / v7 验收资料索引

本轮修复、架构与耗时分析见 [v7 架构优化记录](architecture-v7.md)。[remaining issues](remaining-issues-v6.md) 顶部已增加 v7 逐项状态，下面保留原始 v6 问题表。

| v7 路径 | 用途 |
| --- | --- |
| `acceptance-v7.json` | 最终验收摘要：工程验证 PASS，模型语义质量/审计首次完成率仍未解决，总体 PARTIAL |
| `v7-validation/projection.json` | 生产后端重放 v6 大事件语料，元数据大小、分页无损重建和读取耗时 |
| `v7-validation/browser.json` | 实际 Planner 刷新恢复；原始大轨迹的长时间浏览器刷新、滚动、内存采样 |
| `v7-validation/project-stream.json` | 真实 App 的流式状态与延迟项目切换隔离，使用 transport fixture |
| `v7-validation/observations.json`、`quality-review.json` | 分离路由/规划/执行结果；节点 task 原文行号及语义缺陷证据 |
| `v7-validation/P004-*`、`P005-*`、`P006-*` | Users search / 双 SDK / 审计的主采样；JSONL gzip 保留原始输出，不把截断或超时算成功 |
| `v7-validation/feedback/` | 真实 REVISE → fresh 修复 → ACCEPT → 发布；宿主行为断言和无关分支保留 |
| `v7-validation/audit-second-execution/` | 第三次独立规划图的第二次实际审计执行，无介入，另记源码版本与终态 |
| `v7-catalog/` | 与旧 v6 相同 goal 和 README 契约的三次 Catalog 规划，和 P004 分开统计 |
| `v7-recheck/` | 修正客户端为 SSE 后的单次 SDK 重查，仍在 Planner 默认上限超时 |

v7 的 `PASS` 需按各文件 scope 解读：路由/编译通过不代表图语义、实际执行或整个产品通过。原始大型会话压缩归档，外部 worktree/session 路径记录在 metadata；未修改旧测试项目以制造成功。

建议从这三份文档开始：

- [待解决问题](remaining-issues-v6.md)：区分 v6 已落地修复与仍需迭代的效果/稳定性问题。
- [当前项目逐节点耗时](node-timing-v6.md)：4 节点、5 次执行，失败/介入/审查和总墙钟的构成。
- [完整 v6 验收报告](report-v6.md)：三类规划样本、两轮对比、真实 Graph 完成与独立验收。

## 当前有效证据

| 路径 | 用途 |
| --- | --- |
| `fix-plan-v6.md` | 修复项与对应验证，含本次 Planner 活动恢复补充 |
| `acceptance-v6.json` | 验收状态摘要；模型质量仍为 PARTIAL |
| `v6-browser-final/` | 最终独立文件验收、浏览器回归、源码 manifest、已发布报告 |
| `v6-e2e-recovery/snapshot.json` | 唯一完整的当前最终审计快照，含所有 5 次尝试、13904 条事件和原始输出 |
| `v6-e2e-recovery/metrics.json` | 当前执行的离线统计；原始计费口径与缓存字段保留 |
| `v6-e2e/` | 介入前失败状态和“快节点完成、慢节点仍运行”证据；中间状态已去除重复原始输出 |
| `v6-follow-up/` | 本次 Planner 历史/实时展示验证及清理清单 |
| `v6/`、`v6-final/` | 改进前/后的三类规划样本；保留失败的 Catalog 运行用于真实效果对比 |
| `v6-startup-failure/` | 重复 bash 注册导致 Planner 启动失败的独立证据 |
| `v6-contract-recheck/`、`v6-router-recheck/` | sandbox/feedback 与路由定向复测，包含 Serial 误判 |
| `v6-checks/` | 自动验证日志 |
| `current/`、`report.md`、旧 fix-plan | v6 之前的历史验收，不与本轮结果混用 |

## 本次清理

详细清单：[v6-follow-up/cleanup.json](v6-follow-up/cleanup.json)。测试资料由约 **117.40 MB 降至 60.66 MB**（十进制），清理约 **56.73 MB**；另外删除临时目录中已无必要的 **235.48 MB** 浏览器 trace。总计减少约 **292.22 MB**。

删除了与完整快照重复的 `events.json`、重复保存的浏览器 SSE、与 summary 完全相同的 metrics 别名、过时调试截图/页面文本。四份中间状态快照仅保留结构事件和节点状态，并附原始 output 的长度、SHA256 和最终快照中的 execution ID 引用。完整日志仍在最终快照，可校验对应输出前缀。

没有清除当前后端的 SQLite、工作树、已发布报告；没有删除独立模型失败样本或已有项目测试。旧文档保留时间顺序；`v6-final/external-artifacts.json` 保留被删除 trace 的大小、hash 和删除状态，而不再声称文件可读取。

若重新运行验收脚本，可能重新生成中间文件。`summarize-v6.mjs` 遇到已精简的中间快照会拒绝重新统计，避免将缺省原始输出算成零 token；应使用完整最终快照或保留的既有指标。
