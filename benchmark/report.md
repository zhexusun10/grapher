# Grapher MVP validation and hardening — current checkout

2026-09-13。**当前桌面执行边界内验收 PASS**：三次连续确定性套件通过，最终 12/12 samples 通过。本文已更新为中断后变化的当前仓库；此前报告保留在 [report-initial.md](report-initial.md)，不以旧源码结果替代当前结果。原生 UI 点击和新浏览器模拟器的等价性不在这个 PASS 声明内。

## 1. System under test

先完整阅读根目录 `agent.md`（2,303 行），检查 repository、Rust、React、Tauri、Pi、Git workspace、SQLite、tests/scripts/config。无根级 AGENTS.md；ignored Pi checkout 中的 AGENTS.md 已检查，未修改该 checkout。

当前实际链路：App action → **runtimeService → Tauri JS invoke → 原有 Rust command handler** → compiler/Runtime.create → 待审批 → control(approve) → 原有 desktop drive/jobs/worker threads → 实际 worktree 创建与依赖合并 → shipping demo 或 fresh Pi → Git snapshot commit → SQLite events/reducer → snapshot IPC → 前端状态、TaskNode/输出显示。

真实目标样本另覆盖 plan_goal → Pi Partitioner → serial 单节点图 → 审批 → fresh Pi 执行文件任务。实际多节点模型 Planner 在最终样本中没有被调用；不能宣称其生成质量已经通过。实际 Pi 扩展 loading/mutation rollback/编译器 CLI 的现有 smoke 已通过。

详见 [system-under-test](system-under-test.md)、[resumed-scope](resumed-scope.md)。后者明确区分中断期间的现有产品改动与本轮修复。规范中的推荐库、完整持久多项目 Runtime 等，不假定已经实现。

## 2. Benchmark architecture

[run.mjs](run.mjs) 提供单命令运行、分层结果、源码/环境指纹和 artifacts；[validate.mjs](validate.mjs) 固定执行三次确定性 suite，再运行三次 planned Pi samples，并比较逻辑指标及源码 hash。

[desktop.rs](desktop.rs) 只使用 feature-gated Tauri MockRuntime 替代原生窗口宿主；调用 shipping command handlers/drive，不复制 scheduler，不 mock 核心执行结果。确定性层使用 shipping demo + 实际 Git/SQLite，负向场景用真实 /usr/bin/false 子进程。

B008 运行当前 App action/filter AST、**实际 runtimeService 和 Tauri invoke**，native IPC transport 对接真实 host；断言 isDesktop=true，禁止误入浏览器模拟器。实际 TaskNode SSR、TypeScript structural contract、状态/attempt/revision/失败与历史范围均检查。状态 setters 用于观察前端值；Runtime truth 始终来自产品事件。

固定 IDs B001–B010，稳定 schema v1。每次 run 有 run/case/sample/variant/graph IDs、commit/dirty 信息、源码 hash、起止时间和时长。summary.json、cases.jsonl、events.jsonl、benchmark.log、IPC requests/responses、compiler diagnostics、snapshot、SQLite、worktrees、Pi session/logs 均保留。日志导出复用产品事件；删除负向 fixture 操作前导出原始事件-store snapshot，避免测试本身销毁证据。

详见 [architecture](architecture.md)、[result-schema](result-schema.json)。补充 scripted Pi retry 单测仅检查 adapter 协议，不计入真实 Pi 成功率。

## 3. Baseline（均保留，未重写原始数据）

| 批次 | PASS/FAIL | 确定性 | Agent | 耗时 | 尝试/重跑 |
|---|---:|---:|---:|---:|---:|
| 原始第一次完整 baseline | 8/2 | 8/9 | 0/1 | 80.187s | 23/3 |
| 中断后当前仓库 baseline | 9/1 | 8/9 | 1/1 | 49.310s | 24/3 |
| 当前 final | 12/0 | 9/9 | 3/3 | 91.953s | 34/5 |

[原始 baseline](../benchmark-results/baseline-2026-09-12T14-22-30-778Z/summary.json) · [中断后 baseline](../benchmark-results/resumed-baseline-2026-09-12T19-18-51-989Z/summary.json) · [审阅分类](baseline.json) · [中断后审阅分类](resumed-baseline.json)

所有批次的 NOT_IMPLEMENTED/NOT_APPLICABLE case samples 为 0；未实现能力独立列出而不伪装为通过场景。Harness 覆盖经历有记录的扩充，baseline 与 final 的执行量/时长不是同条件性能比较。原始失败的自动分类是 provisional，reviewed classification 在 findings 中保留。

## 4. Failures discovered

| 问题 | 分类 | Root cause 与处理 |
|---|---|---|
| 初始 TS wire 检查 | BENCHMARK_BUG | excess-property 检查错误拒绝 partial GraphEvent 的合法额外字段；改为保留字段约束的 structural check |
| 初始 Pi timeout / tsx IPC EPERM | ENVIRONMENT_FAILURE | 受限网络/本地 socket 权限；正常权限按固定样本数验证，不改 Runtime 去迎合环境 |
| 默认 Demo 无法从首页开始 | IMPLEMENTATION_BUG | demo 误走 Pi-only plan_goal；恢复 fixed-demo save_graph 入口并说明模式 |
| 节点/介入 timeline 隐藏事件 | IMPLEMENTATION_BUG | UI 用不存在的 event names；对齐 started/finished/failed/invalidated(human=true) |
| 返回最新运行仍只读 | IMPLEMENTATION_BUG | load 把当前 completed run 又设 historical=true；当前 Runtime 加载恢复可交互状态 |
| Runtime 关闭后锁偶发仍占用 | IMPLEMENTATION_BUG | fork 临时继承持锁 file description；Drop 显式 LOCK_UN，稳定 fork fixture 前后复现 |
| Pi 自动重试成功仍返回旧错误 | IMPLEMENTATION_BUG | agent_error 未随成功的最终 assistant message 清空；修复判断，保留原始错误 stream |
| 新 load fixture projects 未初始化 | BENCHMARK_BUG | 补齐与 React 相同的 [] 初值，原期望不变 |
| 中断后 runtimeService 未绑定 | BENCHMARK_BUG | harness 使用旧 direct-invoke closure；导入实际新 service 并桥接 native transport |
| 旧 revision badge 断言 | BENCHMARK_BUG | UI 已有意移除徽章；继续严格断言 wire revision 1→2，并验证可见 attempt/status |
| 新删除操作后端拒绝但 UI 移除索引 | IMPLEMENTATION_BUG | catch 后继续修改 UI；移除吞错，失败保留索引并显示错误 |
| “清空当前工作区”误删全部历史 | IMPLEMENTATION_BUG | 调用了 global clear_history；按实际持久化 Config.repository 筛选，用现有 delete_run，逐条成功后更新 UI，不 reset 其他工作区 |

[完整修复/测试变更账本](findings.md) 包含 original expectation、why wrong、改动、修复前 artifacts。新历史问题在 `resumed-contract-2026-09-12T19-21-20-744Z` 先失败，`resumed-repair-history-2026-09-12T19-23-09-190Z` 后通过。测试含故意错误归类的侧栏索引，并验证其他仓库历史保持完全相同。所有删除只作用于 benchmark fixture。

没有删掉 failing case、替换核心执行结果、把 failure 降级为 warning，或靠不断尝试模型直到偶然成功。所有已观察失败均有分类。

## 5. Changes made

* **src/App.tsx**：Demo 入口/配置可达性、时间线、最新运行交互状态；恢复后新增删除失败处理与按持久化仓库配置限定清空范围。
* **src/types.ts**：补充产品已有 human event 字段。
* **src-tauri/src/runtime.rs**：Runtime Drop 显式释放 flock。
* **src-tauri/src/engine.rs**：复用 output channel 记录 PID/exit；成功重试后清除旧 agent_error。
* **src-tauri/src/desktop.rs**：仅增加 benchmark feature 模块接入；适配器调用原有 handler/drive。
* **src-tauri/tests/engine.rs**：补充重试恢复协议回归，不冒充真实 Pi benchmark。
* **benchmark/**、example、package/Cargo benchmark 配置、README/gitignore：runner、fixtures、schema、记录与复现。

中断期间新增的 runtimeService/Web simulator/rfd/历史 backend/UI 布局/desktop runner 是当前已有改动，已保留；不将它们冒称为本次 benchmark 实现，也未为本次验收创建未来架构 subsystem。

## 6. Final benchmark（当前实现）

[完整 final summary](../benchmark-results/final-2026-09-12T19-26-51-131Z/summary.json) · [验收记录](../benchmark-results/acceptance-2026-09-12T19-25-26-109Z.json) · [汇总 final.json](final.json)

| Case / sample | Scenario | Status | 时长 s | 节点尝试 | 重跑 |
|---|---|---|---:|---:|---:|
| B001 / 1 | Minimal demo execution | PASS | 1.685 | 1 | 0 |
| B002 / 1 | Dependency chain | PASS | 2.899 | 3 | 0 |
| B003 / 1 | Actual parallel fan-out | PASS | 1.969 | 3 | 0 |
| B004 / 1 | Fan-in composition | PASS | 2.911 | 4 | 0 |
| B005 / 1 | Compiler rejects dependency cycle | PASS | 0.015 | 0 | 0 |
| B006 / 1 | Pi process failure propagation | PASS | 0.300 | 1 | 0 |
| B007 / 1 | REVISE then ACCEPT | PASS | 3.606 | 5 | 2 |
| B008 / 1 | Frontend contract and intervention | PASS | 10.403 | 10 | 3 |
| B009 / 1 | Feedback limit and independent branch | PASS | 2.090 | 4 | 0 |
| B010 / 1 | Real Pi file task | PASS | 21.197 | 1 | 0 |
| B010 / 2 | Real Pi file task | PASS | 21.508 | 1 | 0 |
| B010 / 3 | Real Pi file task | PASS | 22.469 | 1 | 0 |

**Pass rate 100%（12/12）；deterministic 100%（9/9）；agent-dependent 100%（3/3，小样本）。** 总耗时 **91.953s**；34 次节点尝试、5 次重新执行、8 次 Pi-command 进程（含 2 个预设失败 executable），3 次 Partitioner、0 次 Graph Planner、0 次 provider retry、0 个未解释 invariant failure。两个非零退出均属预设负向测试，验证 failure 可见与传播；不是意外失败。

实际模型 qwen3.8-max。最终 planned samples：21.197 / 21.508 / 22.469s（min/median/max）；message_end 报告 totalTokens 合计 **18963**，含 Pi 报告的 cache usage，非独立计费推断。

三次连续 deterministic：**31.299 / 26.405 / 26.986s**，均 9/9；每次 31 次 attempts、5 次重跑、2 个预期非零进程。最终 deterministic 子集也一致。全四套代码/依赖锁源码 hash 相同：`062ac1f3d9c802940fba2ca874e7ad09e4d75cb3bc1540aceba0a2776d7e4b8f`。恢复 fixture 的 interrupted attempt 没有真正启动 Pi，因此 attempts/process 数量不同。

旧、新全部模型样本仍保留：受限环境 baseline 0/1；正常权限原 graph-IR 固定组 3/3；旧 serial probe 1/1；旧 planned 固定组 3/3；恢复 baseline graph-IR 1/1；当前 planned 固定组 3/3。不能将不同环境/源码群体混成当前可靠率。

补充 checks：当前 20 个 Rust tests、production frontend build、默认 desktop cargo check 均 PASS。此前实际 Pi extension loading/工具表/mutation rollback smoke PASS，相关 extension/compiler 实现未改动。当前 bundle 主 chunk 574.69 kB 的体积 advisory 保留，无相关执行故障。

## 7. Remaining gaps

* **NOT_IMPLEMENTED（架构未来能力）**：多引擎、远程执行、自动冲突解决、worktree 自动清理/合入结果、完整交互终端、拖线编辑、持久多项目 Runtime、语义目标贡献分析。未伪装成 PASS。
* **Known limitation**：单活动 Graph、波次屏障式并行、Git 源仓库须 clean 且有 commit；demo 不实现任意输入目标；模型依赖已有认证/网络。
* **UI automation gap**：已覆盖真实 service/action/IPC/type/render 和新增历史操作；未驱动原生 WebView 点击、700ms React effects、rfd dialog、titlebar/window lifecycle。
* **Architecture/parity mismatch**：新 Web simulator 实际存在，但不使用 Rust/Git/Pi。其“100% 严格一致”的 client compiler 注释不符合静态检查事实（普通 cycle E207 vs Rust E101、反馈祖先 E209 vs E207、warnings/运行语义差异）。明确排除其模拟成功作为 desktop E2E 证据；未替换/重构该独立 subsystem。
* **Future coverage**：真实 Graph Planner 多节点生成质量（不是 NOT_IMPLEMENTED；本次 serial routes 不调用它）、复杂 merge conflict 完整人工 resolve 流程、长任务/900s timeout、全部退出/暂停组合。一部分有 unit coverage，不等同于完整 E2E。
* **Observability limitation**：planning 有独立会话目录和完成后 buffered log，不具备与 execution 节点完全相同的实时 event-sourced planning；本次所有失败均能通过保存 artifacts 定位。
* **Flaky behavior**：旧 fork-lock 竞态已修复；当前三次 suite 未观察残余确定性不稳定。不能从少量模型样本承诺未来任意任务成功。

因此验收声明仅针对明确的 **桌面 MVP execution + frontend/backend contract**，该边界内无已知 blocker；不把模拟器 parity 或原生 UI 未测部分也宣称已通过。

## 8. Reproduction

项目根目录执行：

```sh
npm run benchmark:validate
```

自动连续三次确定性 suite + 固定三次真实 planned Pi 样本，比较状态、尝试/重试/退出数量与源码指纹。真实 Pi 需要已有认证与联网；runner 自动补齐 Cargo PATH。失败返回非零，但保存结果。

```sh
npm run benchmark -- --deterministic
npm run benchmark
npm run benchmark -- --case B008
```

分别为无模型 suite、单次完整 graph-IR suite、针对性 frontend/history 回归。可配置 BENCHMARK_PI_COMMAND、BENCHMARK_PI_ARGS（JSON array）、BENCHMARK_PI_MODEL。本机默认 /opt/homebrew/bin/node + ignored 本地 Pi checkout。Artifacts 在 benchmark-results 下，源码快照含 Cargo.lock；原始 baseline、恢复 baseline、各修复前失败与 current final 均留存。报告汇总在验收之后更新，生产/harness 代码未为报告变动。
