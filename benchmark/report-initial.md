# Grapher MVP benchmark validation and hardening

2026-09-12。结论：在下述明确的 IPC / frontend contract / execution 边界内，当前已实现的 MVP 达到本次验收条件。原生 WebView 点击与 effects 自动化仍是覆盖缺口，不能把本报告解释为完整原生 UI 自动化认证。

## 1. System under test

首先完整阅读了根目录 `agent.md`（2,303 行）；仓库没有根级 `AGENTS.md`。检查了 Rust、React、Tauri、Pi 扩展、SQLite、Git workspace、现有测试和脚本，发现时工作树干净。基准 commit：`a3b8798234bd9832c4e7a0156d678af8ea01fd0a`；变更状态、diff 和源码快照保存在各 run 下。

真实最小路径为：前端目标/Graph IR → Tauri command → compiler / Runtime.create → 待审批 → control(approve) → 原有 desktop drive → jobs/worker threads → Git worktree 与依赖合并 → shipping demo 或真实 Pi → Git commit → 产品 SQLite events/reducer → snapshot IPC → 前端 action state、TaskNode 和日志显示。

自然语言真实样本还覆盖了 plan_goal → Pi Partitioner → serial 单节点图 → 审批 → fresh Pi。三个最终样本均选择 serial，因此 Graph Planner 的真实模型多节点规划尚未覆盖，不能宣称其可靠率；实际 Pi 扩展加载、工具表、mutation rollback 和 Rust compiler CLI 已由现有 smoke 验证。

详见 [system-under-test](system-under-test.md)。架构规范、实际 MVP、局部实现与尚未实现能力分别列出；浏览器 createPreviewSnapshot 不计入执行成功。

## 2. Benchmark architecture

[run.mjs](run.mjs) 为单命令 runner；[desktop.rs](desktop.rs) 是 feature-gated Tauri 测试宿主适配器，调用原有 command handler 和 drive，不复制调度器。Tauri MockRuntime 仅替代原生窗口宿主。固定 Graph fixture、真实 shipping demo、实际 Git/SQLite 与受控失败进程构成确定性层；真实 Pi 单独统计。

B008 通过实际 App.tsx action/filter AST、真实 IPC、TypeScript structural contract 和实际 TaskNode SSR 验证 frontend/backend。React setters 是观测界面；后台状态仍只来自产品 Runtime。未模拟核心成功结果。新增的 scripted Pi retry test 仅为补充协议单测，完全排除在真实 Pi benchmark 成功率之外。

每个 run 有 benchmark_run_id、稳定 case ID、sample/variant、graph run IDs、git/dirty/source hash、起止与时长。每个 case 留下请求响应、compiler diagnostics、compiled graph、事件、attempt/session/PID、输出/退出码、revision、最终状态、SQLite 和 worktree。`events.jsonl` 导出原始产品事件，未创建第二套 runtime truth。格式见 [architecture](architecture.md)、[result schema](result-schema.json)。

## 3. Baseline

第一次完整、未经行为修复的结果：[原始 summary](../benchmark-results/baseline-2026-09-12T14-22-30-778Z/summary.json)；审阅分类：[baseline.json](baseline.json)。

| 指标 | 原始 baseline |
|---|---:|
| Case samples | 10 |
| PASS / FAIL | 8 / 2 |
| NOT_IMPLEMENTED / NOT_APPLICABLE case samples | 0 / 0 |
| 确定性 | 8 / 9 |
| 真实 Pi | 0 / 1 |
| 总耗时 | 80.187s |
| 节点尝试 / 重跑 | 23 / 3 |

两次失败经检查分别为 BENCHMARK_BUG 与 ENVIRONMENT_FAILURE。原始 JSON 的自动分类是 provisional；原始数据没有重写。基础 harness 此后增加前端入口、过滤器、恢复锁的覆盖，并各自保存修复前失败。因此原始与最终耗时/执行量不是完全同覆盖条件下的性能对比。

## 4. Failures discovered and classification

| 问题 | 分类 | 最小 root cause / 处理 |
|---|---|---|
| B008 首轮 TS 检查错误 | BENCHMARK_BUG | fresh literal excess-property 校验错误地拒绝合法额外 wire 字段；改为保留字段类型约束的 structural check |
| B010 模型请求超时 | ENVIRONMENT_FAILURE，agent-dependent 层 | 受限网络中实际 Pi 的请求及 3 次内建重试超时；正常权限固定 3 样本全部成功，无 Runtime 逻辑修复 |
| 默认 Demo 首页无法启动 | IMPLEMENTATION_BUG | bootstrap 默认 demo，但首页只走 Pi-only plan_goal；恢复 fixed-demo save_graph 入口和显式模式说明/选项 |
| 节点/介入时间线为空 | IMPLEMENTATION_BUG | UI 过滤的是不存在的 node_started/intervene，产品发出 started/finished/failed/invalidated；对齐真实事件 |
| 返回最新运行仍只读 | IMPLEMENTATION_BUG | load() 对 completed 等阶段又设置 historical=true；加载当前 Runtime 时清除 historical |
| 关闭 Runtime 后偶发锁仍占用 | IMPLEMENTATION_BUG | 并发 fork 临时继承持锁 file description；显式在 Runtime Drop 中 LOCK_UN；受控 fork 前后复现，不串行化测试规避 |
| Pi 重试成功仍报旧错误 | IMPLEMENTATION_BUG | agent_error 在最终成功 message_end 后没有清空；按最后 assistant 结果判定，原始错误仍在输出中 |
| 新增 load fixture 未初始化 projects | BENCHMARK_BUG | 测试没有还原 React 的 [] 初值；修正 fixture，期望不变，之后复现真实只读问题 |
| tsx smoke 的本地 socket EPERM | ENVIRONMENT_FAILURE | 执行权限限制；正常权限下同一 smoke 通过 |

完整 evidence、original expectation、测试修正及 targeted run IDs 在 [findings.md](findings.md)。没有删除失败场景、放宽产品不变量或把失败改成警告。所有发现均已分类；无未解释失败。

## 5. Changes made

* `src/App.tsx`：修复默认 demo 入口、运行配置入口、事件过滤和最新运行只读状态；展示 fixed-demo 的真实含义。
* `src/types.ts`：补充产品已有 invalidated.human 的可选字段。
* `src-tauri/src/runtime.rs`：仅新增 Drop 显式释放 flock。
* `src-tauri/src/engine.rs`：沿现有 output channel 添加 PID/退出元数据；清除已被成功重试取代的 agent_error。
* `src-tauri/src/desktop.rs`：仅新增 benchmark feature 下的适配器模块；shipping command/drive 无替代实现。
* Cargo/package scripts、benchmark files、README、gitignore：harness、协议回归、结果格式及复现文档。没有实现架构中的未来 subsystem。

## 6. Final benchmark

[最终完整 summary](../benchmark-results/final-2026-09-12T14-40-17-553Z/summary.json) · [验收记录](../benchmark-results/acceptance-2026-09-12T14-38-59-248Z.json) · [可提交的汇总](final.json)

| Case / sample | Scenario | Status | 总时长 s | 节点尝试 | 重跑 |
|---|---|---|---:|---:|---:|
| B001 / 1 | Minimal demo execution | PASS | 1.683 | 1 | 0 |
| B002 / 1 | Dependency chain | PASS | 2.872 | 3 | 0 |
| B003 / 1 | Actual parallel fan-out | PASS | 1.996 | 3 | 0 |
| B004 / 1 | Fan-in composition | PASS | 2.907 | 4 | 0 |
| B005 / 1 | Compiler rejects dependency cycle | PASS | 0.013 | 0 | 0 |
| B006 / 1 | Pi process failure propagation | PASS | 0.302 | 1 | 0 |
| B007 / 1 | REVISE then ACCEPT | PASS | 3.618 | 5 | 2 |
| B008 / 1 | Frontend contract and intervention | PASS | 8.515 | 9 | 3 |
| B009 / 1 | Feedback limit and independent branch | PASS | 2.095 | 4 | 0 |
| B010 / 1 | Real Pi file task | PASS | 26.779 | 1 | 0 |
| B010 / 2 | Real Pi file task | PASS | 35.358 | 1 | 0 |
| B010 / 3 | Real Pi file task | PASS | 63.716 | 1 | 0 |

最终 12/12 PASS（100%）：确定性 9/9（100%），真实 Pi planned variant 3/3（100%，小样本）。最终套件总耗时 **150.250s**。33 次节点尝试、5 次重新执行、8 次实际 Pi-command 进程启动（其中 2 次为预期的 /usr/bin/false），3 次 Partitioner 调用，0 次 Graph Planner 调用，0 次 provider retry。两个非零进程退出均是负向测试，失败状态与 UI 可见性正确，不是意外失败。

实际模型 `qwen3.8-max`；最终 3 个 planned 样本耗时 26.779 / 35.358 / 63.716s（min/median/max）。这些样本的 Pi message_end usage 合计 totalTokens=19052（包含报告的 cache usage；不是独立 billing 估算）。恢复 fixture 的 interrupted attempt 计入 node attempts，但没有实际启动 Pi；attempts 与 process 数量有意分开。

三次连续确定性 suite：28.857s / 24.366s / 24.673s，全部 9/9。每次均 30 次 attempts、5 次重跑、2 次预期非零退出；全部源码指纹相同：`8384bbd04e1d63a0f6c3a72e23d8e9cfdbcf3a80a4faf504a6d7fabec69be5bb`。最终全量套件确定性部分也一致。

所有真实 Pi 样本完整保留：受限环境 baseline 0/1；正常权限 graph-IR 固定样本 3/3；serial planning probe 1/1；最终 planned 固定样本 3/3。跨环境合计 7/8，仅作审计，不将不同环境混为同一个可靠率。

补充验证：20 个 Rust tests PASS；frontend production build PASS；默认 desktop cargo check PASS；真实 Pi extension smoke PASS。前端 bundle 553.40 kB 的既有 chunk advisory 仍存在，未扩大为无关打包重构。

## 7. Remaining gaps

* **NOT_IMPLEMENTED**：多引擎、远程执行、自动冲突解决、自动清理/合入结果、完整交互终端、拖线编辑、持久多项目 Runtime、语义目标贡献分析。它们列在 summary 和 SUT 中，不伪装为 PASS，也没有为了本次 benchmark 实现。
* **Known limitations**：单活动 Graph、波次屏障式并行、源仓库须 clean、有 commit；demo 写示例 Markdown，不理解任意任务；真实模型需已配置认证和网络。打包体积 advisory 保留。
* **UI automation gap**：真实前端 actions/IPC/type/render 已验证；没有驱动原生 WebView 点击、计时 effects、窗口重启。浏览器预览不是执行证据。
* **Future coverage**：真实 Graph Planner 多节点规划质量、复杂合并冲突的完整 UI resolve 操作、长任务/900s timeout、暂停/退出期间全部进程场景。部分已有 unit coverage，不能等同于 canonical E2E 覆盖。
* **Observability limitation**：planning 使用会话目录与完成后写入的 buffered planning log，不能当成与执行节点完全相同的实时 event-sourced planning。当前所有测试失败均可由保存 artifacts 定位。
* **Flaky behavior**：锁竞态已稳定复现并修复；三次确定性套件未发现残余不稳定性。样本数量不足以证明所有未来模型/环境行为稳定。
* **Architecture mismatch**：spec 推荐的若干 UI 库/完整持久多项目模型尚未实现；partition tool 没有 reasoning 字段；孤立节点只有 W301 警告。未为这些规范差异强行扩展 MVP。

在已测试的 frontend/backend contract 内无已知 blocker。以上覆盖缺口保持可见，验收不等于未来架构全部完成或任意真实任务必然成功。

## 8. Reproduction

在仓库根目录执行：

```sh
npm run benchmark:validate
```

它自动运行三次确定性全量和固定三次真实规划执行，并比较 case 状态、执行数量、重试、进程失败和源码指纹。需要可联网环境、现有 Pi 模型认证；PATH 中的 cargo 由 runner 自动补齐。输出非零代表失败，结果照常保存。

```sh
npm run benchmark -- --deterministic  # 无模型费用，9 个 canonical IDs
npm run benchmark                   # 9 deterministic + 1 真实 Graph-IR Pi task
npm run benchmark -- --case B009     # 定位锁恢复/重试上限
```

可配置 `BENCHMARK_PI_COMMAND`、`BENCHMARK_PI_ARGS`（JSON array）、`BENCHMARK_PI_MODEL`。本机默认使用 `/opt/homebrew/bin/node` 和本地 ignored Pi checkout。原始/最终 artifacts 全部在 benchmark-results；每个 run 的 sources/、source-manifest.json 与 diff 支持追溯未提交实现。报告汇总是完成验收后的文档新增，测试的 production/harness 实现保持原样。
