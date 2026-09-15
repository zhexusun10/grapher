# v7：remaining issues 修复与架构优化

本轮从 `remaining-issues-v6.md`、`node-timing-v6.md`、根目录 `agent.md` 和 `README.md` 出发，先修复可确定的运行与展示缺口，再评估模型质量。历史 v6 证据不改写。真实模型结果、运行目录和源码指纹保存在 [v7-validation](v7-validation/metadata.json)；浏览器与确定性测试不计入模型首次完成率。

## 耗时判断

v6 审批到发布 2304.668s，其中首次汇总失败 900.204s、介入后汇总 188.696s、review 836.410s，两个并行审计的墙钟为 320.669s。人工介入间隔 58.137s，最终发布 0.408s。规划另花 297.690s，审批等待 423.092s。

这个小型服务的审计流程明显过长，且首次不能无人干预完成。但不能把 50 分钟总时间都归因于架构：其中 7 分钟是审批等待；五次 execution 的宿主差额总共只有 1.046s。即使完全消除 Git/worktree 开销，最多也只省约 1 秒，无法解决 15 分钟汇总超时。增加并发也不会缩短汇总 → review 这条依赖链。

优化优先级是：职责与证据去重 → 模型/请求延迟可观测 → 状态与轨迹分离 → 消除无依赖的调度等待。没有提高生产超时，没有降低验证要求，也没有引入常驻 Coordinator、恢复旧 session 或额外 artifact schema。

## 已实施

### 规划生命周期与浏览器连接解耦

开始调用 Pi 前写入 `request.json` 和带 repository、planning ID、createdAt 的 running summary；角色 JSONL 每条事件到达即写文件，结束时不再整段覆盖。summary 用临时文件 + rename 原子替换。`list_plannings(repository)` 可发现活动任务；原 `get_planning_output` 使用 UTF-8 字节游标，返回当前 EOF 与 planning 是否仍 running，两者含义分开。

刷新后由 App 发现当前项目的活动规划，活动卡片从游标追读日志；成功通过 `get_planning_snapshot(planningId, repository)` 找到准确结果，失败显示该次失败。请求取消、工作区和 recovery generation 防止旧响应回写。后端重启把残留 running summary 标为 interrupted failure，保留原日志，不自动启动模型。原始 SSE 仍用于发起端的低延迟展示；恢复使用可取消的游标轮询，不重新提交 goal。

### 状态与轨迹分离

新增 `snapshot_view.rs` 作为只读传输投影，Runtime / reducer 继续拥有唯一状态真值。`detail: "metadata"` 投影：执行记录保留 ID、状态、时间、worktree、SHA、`outputBytes`，`output` 为空；结构事件中去除 `Output` 及 `Finished.output` 大字段。旧 `compact` 仅去掉 Output 事件，仍在 Finished 内留下完整日志，这也是此前约 11.59MB 响应的一部分来源。SQLite 与默认完整 API 的历史含义保持不变。

常规 snapshot 和 bootstrap 直接构造轻量投影，避免先序列化原始日志。当前打开的 execution/merger 使用 `get_execution_output(runId, executionId, offset)`，每页最多 256KiB，边界不切断 UTF-8。切换节点、尝试或项目时取消请求并释放旧会话文本；关闭 merger 详情时不加载其输出。前端继续保持一个在途轮询请求。

这消除了每次状态刷新传输所有会话的行为。当前可见的单个会话仍会在浏览器内积累完整文本；Rust 的事件重放和内存状态也仍保留日志。历史 run 的分页目前仍需要加载该 run 的状态，因此本次不宣称日志存储具有无限可扩展性。

### 实际行高的虚拟列表

`ResizeObserver` 测量每行真实高度；累计偏移 + 二分搜索计算视口和 overscan。保持可见位置锚点，只有用户在底部时跟随新输出；展开/折叠状态保存在会话内，虚拟化卸载后能恢复。外层不受约束导致内部滚动区随内容无限增高的问题也已修复，轨迹视口限制为 65vh。测试必须确认 `scrollTop > 0`，不能仅以 DOM 中有行就声称测过滚动。

### 按空闲并发槽调度

没有 feedback 的 DAG：快节点 finish 后，driver 接收完成通知，按剩余并发容量派发 ready 下游，慢兄弟继续执行。并发上限仍为配置值。空 jobs 只有在全部活动任务结束时才结算和发布，暂停只停止新派发。

含 feedback 的图保留整波屏障：在当前波全部完成后处理 feedback，再计算 ready。这样不会在 reviewer 已 done、REVISE 尚未失效旧子图的窗口派发消费者，也不会修改正在被其他运行节点使用的祖先。事件驱动只优化可安全证明的 DAG 情况；后续若要放宽 feedback 图，需要编译器生成反馈区域与消费屏障，不能直接删除 `active()` 判断。

v6 审计的汇总本就依赖两个审计，因此这一调度改动对它没有可证明的收益；收益用受控快/慢分支测试单独验证，不冒充模型审计提速。例如 A=10s、B=1s，只有 C=3s 依赖 B 时，原来需要 `max(A,B)+C=13s`，现在可做到 `max(A,B+C)=10s`；这是解释调度的假设示例，不是实测模型成绩。

### 规划/执行契约与观测

Planner 明确证据所有者、汇总复用上游证据、review 的独立验收职责、可达的修复负责人；仓库事实要有来源，未定义行为不能变成硬性要求。执行提示补充有界复现、负向测试与实际步骤错误的区分，以及达标即停止。后续还由宿主注入 UTC 执行日期并提醒 Git 基线由宿主验证，避免模型凭记忆填写日期；这项不倒推为初始样本已经遵守。Compiler W302 对没有 outgoing feedback 却提到 `<REVISE>` 的节点返回警告；它不把报告中引用 marker 的字面文本当作非法结构。受限检查支持 `head/tail -N/-nN` 的等价有界写法，减少本轮观测到的格式拒绝重试。语义评审也检查约束矛盾、不可调度修复、重复验证，而非图形/节点数相似度。

Pi JSON 事件增加宿主接收时间 `grapherReceivedAt`，用于统计首个 assistant 事件、工具 start/end、最后工具到进程退出。首响应间隔包含启动、provider、网络和模型工作，不标成纯 provider 延迟或纯推理耗时。无法从宿主可见事件分解的部分明确保留未知。

## 验证原则与剩余边界

- 确定性回归覆盖 Unicode 分页重建、元数据不泄漏大输出、规划断连后的同 ID/游标、项目过滤、中断恢复、DAG 空槽派发及反馈屏障/限额。
- 真实可控缺陷图验证 REVISE → fresh 实现 → ACCEPT → 最终发布，宿主独立执行行为断言并核对无关分支只执行一次。它验证 Runtime 控制流，不证明 Planner 能为任意任务生成正确反馈责任。
- 真实规划按 P004 用户搜索、共享契约与双 SDK、审计重复采样；旧 Catalog CSV 任务另用 v6 原 goal/契约采样，两者不是同一任务。路由结果、调用失败、图质量分别记录。provider 请求超时与命令/职责问题分别报告。
- 浏览器使用 v6 原始大轨迹做持续加载、刷新、滚动与 GC 后内存采样；有限时长通过不证明无限运行没有内存问题。

本轮真实模型已再次暴露：额外报告验证波次、要求以源码检查证明未改动、没有反馈边却要求 REVISE，以及执行节点继续拼接命令/尝试 Git。因此提示词及评审改进属于已实施但质量尚未全部达标；不能把 remaining issues 整张表改为已修复。生产仍默认 Planner 300s、Node Agent 900s，模型失败显式保留证据，未用更大超时换取表面成功。

## 验证结果

生产 release 后端把 v6 原始事件重放进独立数据目录，对完整/compact/metadata API 实测；默认完整记录在查询前后相同，五次 execution 逐页拼接与原输出完全相等。证据见 [projection.json](v7-validation/projection.json)。

| 响应 | 实际 HTTP JSON 字节数 | 单次读取墙钟（本机样本） |
| --- | ---: | ---: |
| 原完整 snapshot | 19,412,868 | 110.4ms |
| v6 compact | 11,594,065 | 57.8ms |
| v7 metadata | 31,694 | 1.44ms |

相对 compact 减少约 **99.73%**。耗时包括本机 HTTP 读完响应，不是后端 CPU 指令耗时；不从这张表推断模型推理提速。

规划采样使用 `dashscope/qwen3.8-flash`、thinking=medium；生产默认 Partitioner 60s、Planner 300s、Node Agent 900s。主采样不同任务族并发，同一族顺序重复；补充 Catalog 在较低并发负载下执行。代码在本轮确定性修复期间有记录的更新，各批次源码指纹分别保留，因此这些是回归观察而非严格固定源码 A/B。

| 主采样任务 | 次数 | 收到正确 Graph 分类 | 完成编译并返回图 | 已观察问题 |
| --- | ---: | ---: | ---: | --- |
| P004 用户搜索前后端 | 3 | 2 | 2 | 1 次 Partitioner 超时；已生成图仍可能把未定义 cursor 行为变成硬规则 |
| P005 共享契约与双 SDK | 3 | 3 | 1 | 1 次 provider 请求超时；1 次测试客户端等待响应头超时后中止宿主 |
| P006 独立审计与发布判断 | 3 | 3 | 2 | 1 次测试客户端中断；两张成功图分别为四节点和三节点，职责质量不同 |
| 原 v6 Catalog CSV + search | 3 | 3 | 3 | 仍有重复验证/报告波次及下游修复负责人不可达问题 |

主采样共有 12 次调用；11 次完成分类的结果都是 Graph，另一次分类调用失败，无分类结果。8 次拿到最终编译图。这里没有 Serial 对照，也没有把 compiler 接受算作语义质量通过。两次测试客户端中断留下 `status=running` 的原始 summary 与完整截断日志；其结果文件明确标为失败，不篡改成正常模型终态。

测试客户端已改用 SSE 接收规划，避免同步接口超过 Node fetch 的响应头等待上限。额外一次 SDK 使用修正后的脚本，仍在产品 Planner 300s 上限超时（含 Partitioner 总计约 313.7s）。因此既不能把两次脚本故障算作模型质量失败，也不能因修了脚本就声称 Planner 耗时问题已解决。所有结果见 [observations.json](v7-validation/observations.json)，任务原文取证见 [quality-review.json](v7-validation/quality-review.json)。

Catalog 三次规划总耗时为 **120.023 / 164.851 / 211.227s**，中位数 164.851s；v6 两次为 142.207 / 250.677s，范围有明显重叠。新样本分别仍有 4、4、5 个节点，问题在重复职责及失败路径，而非节点个数本身。其拒绝工具数为 1、1、3，不能宣称非法只读重试已经归零。

真实反馈样本 **通过**：总执行约 620.176s，calculator #1 → review #1 REVISE → calculator #2 → review #2 ACCEPT → 发布；docs 独立分支只执行一次，所有 session ID 不同，宿主独立断言正数、负数和零的加法行为正确。证据见 [feedback/result.json](v7-validation/feedback/result.json)。review 仍尝试 Git、拼接验证命令及额外复现，所以通过的是反馈控制流与最终行为。

第一次完整审计复跑 **失败**：两个审计分别 443.854s / 727.538s；汇总 900.147s 超时，其下游被阻塞。审批到终态约 1628.536s，没有介入、没有发布，不能计为首次成功。汇总 Pi 为 900.010s，宿主差额仍仅 0.137s。证据见 [P006-1/result.json](v7-validation/P006-1/result.json)。第二次实际执行使用第三次独立规划的三节点图（第二次规划被客户端截断，未执行）；其结果和源码指纹单独存于 [audit-second-execution/result.json](v7-validation/audit-second-execution/result.json)。

## 已完成的浏览器与确定性验证

- 40 分钟长轨迹浏览：38 次刷新、76 次 GC 后堆采样；JS 堆范围 **10,035,308–10,555,436 bytes**，最后一次 10,047,360 bytes；无 page error、无崩溃。使用 v6 的原始长会话与受控 HTTP 传输，不是 40 分钟真实模型持续生成的等价负载。实际滚动从顶部到末尾的 21 个位置均有相交行，展开/折叠改变测量高度。证据：[browser.json](v7-validation/browser.json)。
- 长时测试的布局版本由 [frontend-long-run-build.json](v7-validation/frontend-long-run-build.json) 记录；随后增加的代次防护、终态末行补齐、PID 元数据和规划状态显示由最终构建及单独浏览器回归验证，未把先前 40 分钟倒称为最终全部 UI 代码的完整压力测试。
- 最终构建使用真实 App 的 transport fixture 验证跨项目、慢响应取消、思考增量、工具 running→success，结果 [project-stream.json](v7-validation/project-stream.json) 为 PASS。真实 Planner 刷新恢复的 planning ID 一致且新增模型启动请求为 0，见同一 browser 证据。
- Rust fixture 完整套件 **48 项通过**（含 3 项 macOS 真 sandbox 用例），新增反馈屏障、Unicode 分页、空槽下游调度和 W302；修改后的 engine/lib 定向回归再次通过。前端构建、Pi 基线 4 项、规划/边界评分 17 项、UI/恢复渲染 14 项通过；HTTP 核对规划断连/重启/成功终态查找、历史输出与完整/metadata API；Git/普通文件夹回写 HTTP 和联合 Pi 扩展 smoke 通过。

第二次实际审计执行同样 **失败**：认证节点 142.574s 完成，存储节点 900.104s 超时，release_decision 因依赖失败被阻塞；审批至终态约 900.563s。没有介入，没有发布，用户源目录干净且没有落地改动。存储节点进行了 33 次工具调用，其中 9 次标记错误；其 Pi 时间 900.022s，宿主差额仅 0.082s。

压缩原始日志确认最后一次 bash 调用有 start、无 end，随后收到宿主 timeout 事件。该实验 `probe10.mjs` 创建 `setInterval(() => ticks++, 1)`，只在 `setTimeout` 中打印结果，没有清除 interval，Node 事件循环因此持续存活。这是脚本无法自然退出的直接证据；此前还有多次相近 crash/concurrent-write 实验、Git sandbox 拒绝与一次 provider 错误，不能把整个 900 秒都归给最后的 interval。认证报告正确采用宿主 UTC 日期，并将 Git 基线验证明确留给宿主，但仍尝试被禁止的 Git 命令。

两张独立规划图的实际审计首次完成率为 **0/2**。这个小样本不能估计普遍失败概率，但已足以否定“本轮解决了审计超时/首次完成率问题”的结论。工程修复和 Runtime 自动反馈样本通过，Planner 责任分配、Node 实验纪律与整体模型耗时仍为未关闭项。

## 后续优化边界

后续方向已调整为 [Planner zero-shot 基线](planner-zero-shot.md)：精简主提示，通过工具说明表达执行语义，通过编译诊断支持自行修正。上一轮提出的默认命令预算已撤回。历史模型失败仍保留，新的提示词需要独立采样验收。

下一步应围绕失败样本评估工具能力、工具说明与编译反馈的不足，而不是继续把特定实验方式、报告分工或时限加入通用提示。仅靠自然语言 task 无法可靠推断所有写权限与修复责任，当前不能用关键词硬拒绝所有审计图或自动改写用户图来伪造语义正确性。若引入新的 Graph IR 字段，应同时设计编译诊断、兼容迁移和真实任务验收。

本轮已实施和验证的优化止于上述具体改动；未增加超时、未篡改失败记录、未以 fixture 结果替代模型质量。所有测试进程均已结束，工作区改动保留供审阅。
