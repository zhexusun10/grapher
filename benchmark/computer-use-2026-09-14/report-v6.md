# v6 验收报告：真实规划质量、执行轨迹与耗时

本轮基线为 `56316cd`，在原工作区完成修复；未修改 `pi/` submodule，未提交 Git commit。修复计划见 [fix-plan-v6.md](fix-plan-v6.md)。本报告将生产缺陷、模型效果及验收脚本问题分别归因，保留失败样本，不把成功编译或 fixture 测试当作交付成功。

## 结论与范围

已发现并修复：Planner 启动时重复注册 bash、规划失败恢复竞态、切回项目后旧节点详情遮挡新失败、SSE 断流冒充成功、规划/暂停计时问题、并行快节点被慢节点拖延记录完成、流式卡片不更新与 execution 轨迹混合；对真实长运行中的浏览器崩溃，减少了重复快照传输并约束轮询并发，短期复测通过。补充了 Planner 的文件边界/反馈/报告职责说明，以及 Partitioner 对共同前置任务之后的并行工作的识别说明。

**最终结果：真实 Audit Graph 已完成独立审查、发布及宿主独立验收，状态 `completed`；经过一次针对性介入，不是首次无人干预成功。最终前端大快照、刷新、历史与流式回归通过。Planner 质量仍为部分通过，不能宣称整体无错误。**

模型质量没有达到可以宣称“无错误”的程度。这些是三个小型人工构造任务的有限样本，不代表大型真实仓库的总体准确率或完成率。两轮匹配的 Catalog 图都保留重复验证波次，CSV 节点都触及本次脚本设置的 600 秒预算。SDK 图减少了重复最终验证节点，但一轮额外复测仍出现 Serial 误判；修正分类说明后的单次复测回到 Graph。最终生产构建的真实审计 Graph 执行、发布与独立验收结果在下文记录。

## 环境与证据

- 模型：`dashscope/qwen3.8-flash`；Partitioner、Planner、Node Agent、Merger 均显式指定角色模型和 `thinking=medium`。
- 配置：`maxParallel=2`、`maxFeedback=2`；Node v25.4.0、Chrome 153；macOS 生产 sandbox 开启，后端无 fixture。
- 所有任务均在隔离 Git 仓库中运行，runtime data 与 Grapher/Pi 安装位于被保护源仓库之外；未操作原来监听 1457 的后端。
- 三种独立任务：Catalog 两个模块依据已有契约并行；新 retry 契约 → TS/Python SDK → 联合反馈审查；auth/storage 两项独立审计 → release 决策。
- 每轮目录有源码 manifest、任务/配置、route、graph、Pi session、工具输出及指标。各轮原始源码 hash 不回写成最终版本；最终执行另有 [源码 manifest](v6-e2e/source-manifest.json)。
- [启动失败证据](v6-startup-failure/metadata.json)、[修复启动后的样本](v6/metrics.json)、[提示词改进后的匹配样本](v6-final/metrics.json)、[sandbox/feedback 定向复测](v6-contract-recheck/)、[路由修正复测](v6-router-recheck/metrics.json)。
- 逐次工具记录的 `assistantCompletedAt`、`resultPersistedAt` 来自持久 Pi 会话；它们不能视为纯模型计算时长或精确网络首 token 时间。`postLastToolSeconds` 表示最后工具结果到 Pi 退出的尾段。

## v5 验收及产品修复

| 问题 | 真实证据与影响 | v6 处理及验证 |
| --- | --- | --- |
| 旧摘要仓库归属 | V5-1 已有回填和 fail-closed 过滤 | Rust/HTTP 混合仓库与未知归属测试通过 |
| 旧列表/补查覆盖新规划或切换结果 | 列表请求的失效仅发生在下次查询启动时 | 实际恢复控制器代次、仓库与规划 ID 校验；延迟顺序单测及真实浏览器通过 |
| 失败恢复后 UI 不显示 | 切回 A 自动选中旧图节点，遮住已经恢复的失败卡 | 最新失败恢复时回到全局任务视图；A→B→A→刷新通过 |
| SSE 断流被旧 snapshot 伪装成成功 | 前端未收到 complete 也会读取当前 run | 改为显式失败；不再查询旧 snapshot |
| Planner 不能启动 | 三个真实 Graph 请求均报 `Tool "bash" conflicts with .../grapher-planner.ts` | 通用扩展只在执行角色注册 bash；联合扩展加载/只读边界 smoke 及真实规划通过 |
| 耗时文本不可见 | `.primary` 按钮样式把统计数值盖成蓝色块 | 独立统计类；Chrome 确认蓝色文字、透明背景 |
| 暂停计时不增长 | 计时 effect 原来只服务审批等待，已审批后的暂停没有 clock 更新 | 将当前暂停纳入 clock 条件；真实 UI 从 1.7s 增长到 3.7s，随后继续成功 |
| 大快照与轨迹更新 | 最终真实页面 reload 报 Page crashed；轨迹组件还有原地修改 memo props、按长度复用不同 execution 的问题 | compact 响应保留 transcript、过滤重复 Output 事件，轮询串行并取消过期请求；轨迹更新发布新对象、按 execution ID 重置并限制虚拟列表索引；最终浏览器回归通过 |
| 快节点一直显示运行 | 第二轮搜索 Pi 实际 174.315 秒退出，但 Runtime 到 600.117 秒才记录完成 | 工作线程及时 finish；保留波次屏障和 review 顺序；45 项 Rust 与 HTTP/发布通过，真实快慢节点截图也验证 |

[浏览器恢复结果](v6/recovery/result.json) 使用实际生产后端生成的失败摘要与旧 run。仅在竞态用例中延迟真实 HTTP 响应，未伪造摘要；此前失败的网络/截图调试副本已在后续授权清理中删除，保留修复原因及最终恢复验证，详见 [清理清单](v6-follow-up/cleanup.json)。真实完整执行的模型调用没有 mock。

## Planner 图质量

评价依据是 `agent.md` 的交付覆盖、fresh worker 任务自包含、必要依赖、可合并文件边界、有意义的并行、反馈可达性及修正责任。文档中的示例图不作为标准答案。下述“重复”判断来自职责与证据重叠，不来自节点数量偏好。

| 样本 | 做得较好 | 仍存在的问题 |
| --- | --- | --- |
| Catalog，改进前 4 节点/3 普通边 | 两个实现节点分别拥有模块与单测；集成依赖两者；所有交付有负责人 | integration 与 report 重跑相同套件；integration 同时禁止改源码又给条件性修复例外；Planner 将部分未定义边界写成硬规则；两个节点名含空格被 E201 拒绝 |
| Catalog，改进后 4 节点/3 普通边 | 名称合法；对未定义行为改为记录解释；报告节点明确拥有 fix-and-rerun 路径 | 仍拆成集成与报告两个重叠波次；“拒绝 malformed 数据可以 throwing 或 filtering”的例示有契约漂移风险；集成的修改权限表述仍不够明确，且它若失败会阻止下游修复者启动 |
| SDK，改进前 5 节点/5 普通边/2 feedback | 共享契约在两种语言实现前；TS/Python 可并行；review 向两实现发反馈 | 多出重复 final-verification；review task 明说 verdict 后再列发现，和最终行协议冲突；对契约歧义的纠正权未完全闭合 |
| SDK，改进后 4 节点/4 普通边/2 feedback | 去掉重复最终节点，结构职责更紧凑；反馈目标是实现负责人 | 工具检查仍出现非法命令；另一次路由误判为 Serial，显示并行识别不稳定 |
| Audit，改进前/后均 4 节点 | 两项审计可并行；release 使用两份报告；独立审查有引用准确性等不同证据职责，不能仅因第四个节点存在就判冗余 | 早期图要求 sandbox 内 `git status/diff` 或未提供的基线；早期反馈只回到无权改审计报告的 synthesis 节点；某些节点任务编造了不存在的调用关系 |
| Audit，sandbox/feedback 定向修正后 | verdict 放到最后一行；汇总节点获得三份报告的最终纠正权，review→汇总的反馈责任有实际闭环；不再显式要求 git 命令 | 仍出现“不要改源码，但若此前改过应恢复”的矛盾性例外；Planner 对当前调用关系的臆测仍需 worker 重新核验；报告质量不能由编译器保证 |

这些现象表明结构编译器工作正常，语义质量仍取决于模型。提示词改动的效果有改善也有未改善项，没有添加固定节点数、固定名称或样例图相似度规则来制造通过结果。

## 规划时间与 token

以下是同任务、模型、thinking 配置各一次样本。运行时系统负载及 provider 响应延迟未完全控制，不能从一次变化断言因果或总体性能改善。Planner token 是 Pi 报告的 input/output/cache usage 累计值；reasoning 为其中分项，不重复相加。

| 任务/版本 | 分片＋规划墙钟 | Planner 进程 | 工具数/错误 | Planner token | 最后工具后尾段 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Catalog / 改进前 | 142.207s | 132.101s | 15 / 2 | 44,727 | 36.909s |
| Catalog / 改进后 | 250.677s | 239.724s | 14 / 1 | 56,205 | 27.204s |
| SDK / 改进前 | 253.627s | 238.979s | 26 / 3 | 50,229 | 11.945s |
| SDK / 改进后 | 194.929s | 177.464s | 22 / 3 | 57,722 | 20.722s |
| Audit / 改进前 | 406.170s | 381.589s | 17 / 3 | 63,419 | 49.901s |
| Audit / 改进后 | 315.511s | 305.439s | 20 / 2 | 62,373 | 62.089s |

主要开销包括不改变图边界的重复目录/契约检查、被只读工具拒绝后重试、长节点指令以及最后 mutation 之后的较长模型收尾。Catalog 虽少一次工具错误，耗时和 token 反而更高；SDK 去掉重复节点后仍没有稳定降低 token。不能给出“v6 已显著提升 Planner 效率”的结论。

额外 sandbox/feedback 修正样本的 Audit 规划墙钟为 297.690s；分类修正后的 SDK 为 257.166s。额外 SDK 误判 Serial 的样本完整保留在 `v6-contract-recheck/sdk/`，随后测试进程停止；它不计为 Graph 成功。

## Catalog 实际执行失败与计时修复

两轮均通过真实浏览器完成提交、刷新、审批；审批前 executions=0，审批后两个节点并行。CSV 节点分别在修正自己生成的测试时用完脚本的 600 秒预算，搜索节点成功，其余节点被阻塞，没有发布，也没有最终验证报告。两轮均不得记为首次无人干预完成。

这里的 600 秒由验收脚本显式设置，低于产品 Node Agent 默认 900 秒；因此它说明该模型在该预算下未完成，不证明默认预算下必然失败。没有为了获得通过而删除这两次记录，也没有把后续不同任务的成功作为它们的修复成功。

| Catalog 轮次/节点 | Pi 实际进程时长 | 修复前 Runtime 记录时长 | 结果 |
| --- | ---: | ---: | --- |
| 第一轮 CSV | 600.038s | 600.119s | 超时 |
| 第一轮搜索 | 428.335s | 600.119s | 成功，但结束事件延迟 |
| 第二轮 CSV | 600.017s | 600.116s | 超时 |
| 第二轮搜索 | 174.315s | 600.117s | 成功，但结束事件延迟 |

后端现按完成顺序记录事件。当前版本的真实审计 Graph 中认证节点在 storage 仍 RUNNING 时已经有 completedAt 并显示 DONE；[快慢节点证据](v6-e2e/fast-sibling-finished.json) 与 [截图](v6-e2e/03-independent-completion.png) 可复核。历史错误时间没有静默改写，不能将其当作纯工作时间。

## 最终构建的端到端执行

使用真实 Planner 生成并已通过编译的 Audit 图，重启到最终生产构建后从持久历史恢复待审批状态，再通过 Chrome 点击审批。图未手工改写。规划版本、运行版本分别锁定；这同时验证了“重启不会自动审批或执行”。节点采用产品默认的 900 秒预算。

第一次尝试中，认证审计在 213.003s 完成、存储审计在 320.669s 完成，确实独立记录结束。汇总节点在重复磁盘镜像复现、修复复现环境及等待模型响应期间耗尽 900s，未产生 release.md，Runtime 正确进入 needs_attention，未发布。该阶段最后一次工具结果到进程超时有 203.750s，不能将全部时间视作有效实验工作。

随后通过真实 UI 对汇总节点提交一次[针对性介入](v6-e2e-recovery/human-intervention.json)：使用既有审计证据、停止重复磁盘/ENOSPC 实验、控制报告篇幅，明确日期和空白测试不提供行为覆盖。Runtime 只失效汇总及下游审查，两个成功审计节点保持原 session/head。汇总第 2 次 fresh execution 在 **188.696s** 完成，写出 release.md 并纠正了上游关于占位测试的表述。独立审查在 **836.410s** 完成，最终一行为 `<ACCEPT>`。Runtime 自动发布，`PublicationStarted` → `PublicationCompleted` 为 **0.408s**，最终提交 **`c2d5c422c45e33ed55d684ab931505e7295ff93c`**。

Run ID：`1ee4611f-077b-4d2f-96dc-bfb5f4c51f25`。从审批到完成 **2304.668s（38分24.7秒）**，包含失败尝试及介入间隔；从规划开始到发布 **3025.449s（50分25.4秒）**，其中审批等待 **423.092s**。短暂停/继续检查为 4.010s，当前节点未被停止。不能把并行节点耗时相加当成墙钟时间。

| Execution | 结果 | Runtime 耗时 | Pi 进程耗时 | 工具数/错误 | token（含 cache read） |
| --- | --- | ---: | ---: | ---: | ---: |
| auth 审计 #1 | completed | 213.003s | 212.794s | 14 / 3 | 102,629 |
| storage 审计 #1 | completed | 320.669s | 320.465s | 25 / 2 | 208,930 |
| release 汇总 #1 | failed，超时 | 900.204s | 900.040s | 17 / 5 | 106,655 |
| release 汇总 #2 | completed，介入后 | 188.696s | 188.418s | 15 / 1 | 174,750 |
| 独立 review #1 | completed，ACCEPT | 836.410s | 836.219s | 17 / 4 | 292,355 |

五次 Execution 合计 Pi 报告 **885,319 tokens**，其中 cache read 706,304、input 135,129、output 43,886；reasoning 是其中分项而非额外相加。工具错误中包含预期复现出的 ENOENT/EFBIG、无匹配 grep，也包含真实的复现步骤错误与不必要的 git 尝试，不能把工具错误率直接当作节点失败率。没有 Serial 端到端对照，不据此声称 Graph 节省总 token。

[独立验收](v6-browser-final/independent-acceptance.json) 确认：只改变 `reports/` 下的三份报告和五个复现脚本，所有应用源码保持原样，仓库干净，发布 SHA 与源目录 HEAD 一致；直接调用未修改的 authenticate，过期会话仍返回 test-user，与报告核心观察一致。最终文件：[release.md](v6-browser-final/reports/release.md)、[auth.md](v6-browser-final/reports/auth.md)、[storage.md](v6-browser-final/reports/storage.md)。[完成后的 UI](v6-browser-final/04-published-settled.png) 显示四节点 DONE 和已写回目录。

[运行不变量](v6-browser-final/runtime-invariants.json) 确认：审批后 Graph、规划 metrics 和 Planner 日志均未变；五次 execution 的 session ID 全部不同；人工介入只失效汇总与下游 review，两个独立审计未重跑。真实反馈仅观察到 `<ACCEPT>`，没有触发 `<REVISE>`；拒绝重试/限额由 fixture 回归覆盖，不能假称本轮真实模型已经走过拒绝反馈。

独立 review 仍有局限：它尝试了 sandbox 中不可用的 git，并以 mtime/grep 推断源码未改，这不足以替代完整基线比较。本轮由宿主 Git diff 独立补足该验证；不把模型 review 的 ACCEPT 当作所有语义结论的人工金标。

历史与实时 UI 已独立验证：[新旧 execution 切换及计时](v6-e2e-recovery/history-and-live-ui.json)、[暂停/继续计时](v6-e2e-recovery/pause-resume-ui.json)。首次失败证据在 [v6-e2e](v6-e2e/)，介入后的事件与最终文件在 [v6-e2e-recovery](v6-e2e-recovery/)。这不是首次无人干预完成，不将人工收窄任务后的结果混入首次成功率。

## 验收脚本及环境问题

两次耗时较长的 Audit 非流式 HTTP 请求超过 Node fetch 默认等待响应头的时间，客户端报错，但后端分别在 406.170s、315.511s 完成并持久化了合法待审批图。已从事件库只读恢复 snapshot，不重新调用模型；原客户端错误仍保留，不能误判为 Planner 编译失败。复现脚本改用 `plan_goal_stream`，与产品前端一致。

第一轮长浏览器 trace 下曾出现一次 reload 超时；该次没有页面崩溃证据。随后 Audit 实际发布完成后，长期打开、无 trace 的页面明确报了 `Page crashed`。保留原始失败 metadata，不能将原浏览器调用记为成功。

针对该现象减少重复传输、限制在途请求，并修复轨迹的 memo 更新和 execution 身份隔离后，[最终浏览器验证](v6-browser-final/result.json) 使用同一个真实完整快照：原响应 **19,412,857 bytes / 13,904 events**，compact 为 **11,594,054 bytes / 25 个结构事件**，减少约 **40.3%**，所有 execution 输出仍完整保留。5 秒延迟响应下最大在途数为 1；连续刷新 20 次全部成功，就绪耗时约 808–854ms，首次 932ms；强制 GC 后 JS heap 从 25,783,128 bytes 到 25,795,528 bytes，未观察到显著增长。长轨迹末尾不为空，实际 App 的思考增量、工具 running→success 和长短 execution 切换隔离用例通过。

此测试证明本次大快照和短期反复刷新可用，不证明 17 分钟以上的所有长时崩溃根因都已消除。compact 仍有 11.59MB，后续可按 execution 按需或增量获取轨迹。完整旧 trace（约 235MB）已在后续授权清理中删除，原路径/大小/hash 及删除状态见 [external-artifacts.json](v6-final/external-artifacts.json)；必要截图、原始模型轨迹和最终完整 snapshot 仍保留。重复中间输出的清理范围见 [资料索引](README.md)。

规划、执行、最终浏览器修复发生在不同迭代，源码 manifest 分别记录，不倒填版本。最终响应投影与 UI 版本见 [v6-browser-final/source-manifest.json](v6-browser-final/source-manifest.json)，最终 diff 也保存在该目录。

## 自动验证与复现

[验证日志](v6-checks/)：前端构建；Pi 基线 4 项；规划边界/评分 17 项；Rust 45 项（含 sandbox 3 项和新增快慢节点测试）；UI/回写渲染与生产恢复控制器 13 项；HTTP 与 publication HTTP；实际 Pi 联合扩展 smoke。以上均通过。真实 Chrome 恢复、延迟响应、耗时文本和计时增长也通过。

用户复核后的补充：Planner 的实时文字/思考在 complete 后被隐藏、历史刷新只有摘要的问题已修复。现在规划摘要下可按需分页查看 Partitioner/Planner 活动；验证在 [v6-follow-up/planning-activity-result.json](v6-follow-up/planning-activity-result.json)。仍未完成的问题汇总到 [remaining-issues-v6.md](remaining-issues-v6.md)，当前任务逐节点耗时在 [node-timing-v6.md](node-timing-v6.md)。

当前保留一个使用最终构建、已完成数据的本地查看服务：[http://127.0.0.1:1500](http://127.0.0.1:1500)。进程与数据目录见 [review-server.json](v6-browser-final/review-server.json)。可查看四个节点、五次 execution、失败/介入历史及最终发布记录。

主要复现入口：`accept-v6.mjs`（匹配三类样本和 Catalog 实际运行）、`recovery-v6.mjs`（真实失败恢复）、`recheck-v6.mjs`（定向规划）、`execute-v6.mjs`（审计图实际执行/指定节点介入）、`verify-published-v6.mjs`（最终发布独立验收、大快照与轨迹 UI 回归）、`summarize-v6.mjs <证据目录>`（离线提取时间与轨迹）。浏览器脚本需要通过 `PLAYWRIGHT_MODULE` 指定本机已安装的 playwright-core 模块；没有向项目新增浏览器依赖。
