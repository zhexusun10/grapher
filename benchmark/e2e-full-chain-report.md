# Grapher 全链路图任务验证报告

> 证据根目录：`benchmark-results/e2e-full-chain-2026-09-15T07-07-04Z/`
>
> 修复后 Planner-only 复跑见第 10 节；统一 `/workspace` 接口落地及最新复跑见第 12 节。两次均在生成图后停止，未执行节点。

## 1. 结论

本次使用真实浏览器、生产前端构建、Rust 后端、真实 Partitioner/Planner/Node Agent 和 Git worktree，完成了一次 5 节点图任务的规划、审批、并行执行、依赖合并、发布与独立验收。

**核心产品链路结论：PASS。**

- 前端提交目标：PASS
- Partitioner 路由：PASS，输出 `graph`
- Planner 编译：PASS，5 节点、5 边、4 层、0 warning
- 浏览器审批：PASS
- 多节点隔离执行：PASS，5/5 一次完成
- 并行调度：PASS，parser/search 同时启动
- 下游依赖合并：PASS
- 自动发布：PASS，最终 HEAD `dcb2b50fa1bfd42c499dd0ebaa28d3f276798825`
- `npm test`：PASS，86/86，0 fail，0 skip
- 独立隐藏验收：PASS
- 变更路径白名单：PASS
- README/package.json 保持不变：PASS
- 最终 Git 工作树：clean

原始 E2E 脚本退出码为 FAIL，原因是所有产品验收完成后，脚本把一次没有 URL 的 generic browser console 404 当成阻断错误。已记录的 1,904 个浏览器 API 响应和 791 个采集器 API 响应全部为 HTTP 200；使用同一完成态数据做无模型页面复查时没有观察到任何 `>=400` 响应或 request failure。因此最终裁决为 **PASS_WITH_OBSERVATION**，不改写原始 FAIL 元数据，详见证据目录中的 `final-assessment.json`。

## 2. 验证范围与环境

- 时间：2026-09-15 07:07:04Z 至 07:27:52Z
- 总墙钟时间：约 20 分 48 秒
- 模型：`qwen3.8-flash`
- Partitioner thinking：`off`
- Planner/Node Agent thinking：`medium`
- 前端：生产 `dist`，Chromium headless，1440x1000
- 后端：当前源码重新构建的 `backend/target/debug/grapher`
- fixture：独立 Git 仓库，不修改 Grapher 工作区
- 并发上限：2
- Graph run：`2dac1694-1ca4-4c53-a139-f94d28d73352`
- Planning ID：`3fc1e439-5f31-4868-9e6d-491043d535c2`

源码证据在运行开始时按 SHA-256 固化于 `metadata.json`。任务要求 5 个实质节点和 7 个允许修改的路径，业务契约只使用 Node 内置能力，便于做确定性验收。

## 3. 实际运行轨迹

| UTC 时间 | 阶段 | 结果 |
| --- | --- | --- |
| 07:07:04 | 初始化 fixture 和基线 commit | `a5433ce` |
| 07:07:13 | 浏览器加载生产前端 | 成功 |
| 07:07:15 | 前端设置页绑定临时 Git 工作区 | 成功 |
| 07:07:16 | 前端调用 `/api/plan_goal_stream` | 成功 |
| 07:07:24 | Partitioner 路由 | `graph` |
| 07:08:49 | Planner 完成 | 5 nodes / 5 edges / 4 batches |
| 07:08:49 | 浏览器审批并启动 | 成功 |
| 07:08:51 | `contract-catalog` 启动 | 独立 worktree |
| 07:11:09 | contract 完成，parser/search 同时启动 | 并行调度成立 |
| 07:14:38 | parser 完成 | search 不受影响继续运行 |
| 07:19:29 | search 完成，integration 启动 | 两分支合并成功 |
| 07:24:45 | integration 完成，verification 启动 | 成功 |
| 07:27:49 | verification 完成 | 5/5 done |
| 07:27:49 | publication started | 5 个有效 node heads |
| 07:27:50 | publication completed | 约 616 ms |
| 07:27:52 | npm/隐藏验收/白名单检查 | 产品检查全部通过 |

后端最终事件类型为：`created` 1、`approved` 1、`started` 5、`prepared` 5、`finished` 5、`publication_started` 1、`publication_completed` 1。没有 failed、blocked、feedback、merger 或人工介入事件。

## 4. Planner 质量分析

### 4.1 做得好的部分

**路由正确。** Partitioner 用 5.040 秒、358 tokens 输出唯一单词 `graph`，没有无关解释或工具调用。

**拓扑正确。** Planner 生成了预期结构：

```text
contract-catalog
  ├─ impl-parse-catalog-csv ─┐
  └─ impl-search-catalog ────┴─ integration-tests ─ verification-report
```

- 节点数 5，边数 5，4 个执行层
- 单 root、单 terminal
- parser/search 正确并行
- integration 同时依赖两个实现分支
- verification 只在 integration 后执行
- 没有不必要的 feedback 边
- 路径所有权互斥，最终无 merge conflict

**结构生成稳定。** Planner 执行 5 次 `node` 和 5 次 `edge` mutation，10 次全部成功，工具错误为 0；最终编译无 warning。节点具备目标、输入、所有权、约束和完成证据，fresh worker 可以独立执行。

### 4.2 主要质量问题

**P0：Planner 工具面与架构契约发生偏移。**

`agent.md` 明确规定 Planner 应具有 `node / edge / read / bash` 四个工具，其中 `read` 用于读取 Repository/Workspace，`bash` 是不执行任意 shell 的受限只读检查入口；Planner Inputs 也包含“当前 Repository / Workspace 的只读可见性”。但当前生产后端将 Planner 白名单设为 `node,edge`，当前 prompt 声明无 repository inspection tools，本次 Planner 原始轨迹的 10 次调用也确实只有 `node/edge`。

该偏移由提交 `3e104f4` 引入：它从 `backend/resources/planner.ts` 移除了受限 bash 注册和 read 路径守卫，从后端移除了 `planning-inspection.mjs` 的资源提取，并将生产及 benchmark 白名单改为 `node,edge`。`README.md` 同一提交被改为仅 `node/edge`，因此 README 与架构主文档 `agent.md` 当前互相矛盾。受限检查实现和回归测试仍保留为 legacy utility，说明不是从未实现，而是近期被禁用。

这与本次 fidelity 问题有直接关联：用户目标要求按 fixture 的 `README.md` 契约规划，但 Planner 无法读取该权威输入，只能把读取责任下放并猜测可能存在的契约维度，随后引入了 README 中不存在的行为。恢复 `read` 和受限只读 `bash` 应作为 Planner 修复的一部分；同时必须保留按需检查约束，避免恢复历史版本中过度探索仓库的问题。

**观察：Planner 生成了权威契约中不存在的需求。**

虽然 planner prompt 明确要求“不猜测仓库事实、不把未指定选择变成要求”，实际节点任务仍主动枚举了：

- contract 节点：date formatting、null handling、BOM、sort、pagination/limit、tie-breaking
- parser 节点：BOM、header-only 行为、额外 normalization/determinism 细节
- search 节点：排序、分页、limit、optional fields、unknown options、diacritic/normalized matching
- integration 节点：要求“optional/empty fields and duplicate rows survive parsing”，这与 README 中 duplicate/invalid row 必须抛错直接冲突

Planner 同时又写“不要发明 README 未指定的要求”，形成任务内部冲突。后续 contract worker 为消解这些要求，写出 329 行契约并引入大量 `[CHOICE]`/`[OPEN]`，说明问题不是仅停留在措辞层面，而是实际改变了执行范围。

**观察：任务规格较长，执行成本较高。**

- 用户目标：133 词
- 5 个节点任务：共 1,328 词、10,614 字符
- 放大倍数：约 10 倍
- 单节点任务：231 至 289 词
- Planner 自身：87.902 秒、8 assistant messages、36,684 total tokens

大量重复的禁止修改路径、测试清单和未指定边界没有提升拓扑正确性，却把小型 fixture 推向 1,919 行变更和 86 个测试。

**P1：集成节点重复单元测试职责。**

integration task 不只验证两个模块接口互操作，还再次要求 normalization、BOM、CRLF、quoted field、duplicate、determinism、stable ordering 等上游单测维度。最终 `tests/integration.test.mjs` 达到 468 行，接近 `tests/search.test.mjs` 的 479 行。集成测试应聚焦跨模块契约，而不是复制两个分支的完整矩阵。

**P1：Planner 的规格膨胀被 worker 放大。**

| 节点 | 耗时 | 工具调用/错误 | Total tokens |
| --- | ---: | ---: | ---: |
| contract | 139.4s | 6 / 0 | 44,607 |
| parser | 208.6s | 12 / 3 | 160,382 |
| search | 500.5s | 18 / 5 | 357,326 |
| integration | 315.5s | 18 / 2 | 382,866 |
| verification | 183.7s | 14 / 1 | 141,863 |

节点累计 68 次工具调用、11 次错误结果、1,087,044 total tokens。search 轨迹明确花费多轮调试 README 未要求的 Unicode/diacritic 测试；integration 也因扩展矩阵出现测试失败并修正。不能把全部成本都归因于 Planner，Node Agent 自身也存在过度实现，但 Planner 的明确枚举为这种扩张提供了直接输入。

### 4.3 问题归因

本次最优先的问题是 Planner 工具面偏离 `agent.md`，缺少读取权威仓库信息的 `read` 和受限只读 `bash`。规格扩张可能是无法访问权威输入的衍生行为，需要在恢复工具后复跑确认，不将其认定为独立 P0，也不据此新增限制。图结构能力本身正常，节点划分、依赖、并行关系和文件边界均正确。

Node Agent 是次要放大因素：contract worker 将这些候选维度固化为 329 行契约，search 和 integration worker 又围绕扩展契约生成并调试大量测试。运行时调度、worktree 隔离、依赖合并和发布本次没有暴露正确性问题；前端恢复轮询空转则是独立的性能问题，不属于 Planner 质量问题。

## 5. 功能与运行时验收

最终发布恰好修改以下 7 个允许路径：

- `contracts/catalog.md`
- `src/catalog.mjs`
- `src/search.mjs`
- `tests/catalog.test.mjs`
- `tests/search.test.mjs`
- `tests/integration.test.mjs`
- `reports/verification.md`

`README.md`、`package.json` 和依赖均未改变。`npm test` 结果为 86 pass、0 fail、0 skipped。独立隐藏验收另行验证：

- CRLF CSV
- quoted comma
- doubled quote escaping
- exact integer cents
- duplicate SKU rejection
- invalid price rejection
- case-insensitive query
- inclusive price bounds
- stable result order
- input non-mutation
- invalid min/max rejection

所有 Execution Instance 使用不同 session ID 和独立 worktree。主 fixture 在 publication 前未出现节点文件；下游只在依赖完成后启动；最终自动发布后 Git 工作树 clean。

## 6. 前后端轨迹发现

### 6.1 恢复轮询存在持续空转

浏览器在约 20 分钟内发出：

- `snapshot`：1,130 次
- `list_plannings`：767 次
- 其他 API：7 次

所有 1,904 个已记录浏览器 API 响应均为 200。`list_plannings` 在 planning 已成功、graph 已进入执行后仍每 1.5 秒轮询，因为恢复 effect 在找不到 running planning 时会永久继续。此请求对执行页没有增量价值。

建议：规划完成并拿到 planning ID 后停止恢复发现轮询；只在页面首次加载、仓库切换或已知 running planning 时高频查询。空闲发现使用指数退避或至少 15 至 30 秒。运行态 snapshot 可保留较快刷新，但 1 秒持续 19 分钟会产生大量 metadata 请求，长期应改为事件流或 2 至 3 秒自适应刷新。

### 6.2 E2E 网络错误归因不足

首版脚本只保存 `/api` response URL，导致 generic console 404 无法归因。复查时没有重现 4xx。脚本已改为保存所有 `>=400` response 和 `requestfailed` URL，并只把 page error、request failure、API 失败、JS/CSS 加载失败作为阻断错误；普通 console 仍完整保留供审阅。

## 7. 优化建议

### P0：恢复 Planner 的受限仓库检查工具

以 `agent.md` 为架构契约，恢复 `node / edge / read / bash` 四工具面：重新启用 repository-scoped `read` 路径守卫、自定义受限只读 `bash`、`planning-inspection.mjs` 资源提取及生产白名单。`bash` 继续由专用解析器执行白名单读取操作，不应放开 Pi 原生任意 shell。

同步修正 `README.md`、Planner prompt、`benchmark/system-under-test.md`、`planning-boundary.mjs` 和扩展回归测试。当前 benchmark policy `planner-graph-tools-v1` 会把任何成功的 `read/bash` 判为边界失败，不能只改生产白名单而不更新评测契约。

工具使用原则应保持为：只有当仓库事实会改变节点边界、依赖、并行性、可合并性或权威约束时才检查；实现步骤、详细测试设计和只会让 task 更长的调查仍留给 worker。

规格扩张与重复测试暂作为观察项：它们可能源于 Planner 无法读取权威输入，尚不足以归因为独立问题。先恢复检查工具并复跑，暂不增加 fidelity 提示词限制、任务长度限制或审批质量门禁。

### 待复跑观察：集成测试范围

集成测试重复上游单测的现象保留为观察项；恢复权威输入访问后复跑，再判断是否需要调整职责划分，暂不增加固定测试矩阵限制。

### P1：停止无意义 planning recovery 轮询

修正 `src/App.tsx` 的 planning recovery effect：当当前仓库已有成功 planning 对应的 active run，或 graph phase 已进入 `awaiting_approval/running/completed` 时停止 `list_plannings`；仅对已知 running planning 保持 1.5 秒轮询。

### P2：降低 Planner mutation 往返

当前 10 次 mutation 无错误，结构很简单但仍用了 8 个模型回合。`node` 工具增加 `nodes / edges` 批量参数，支持一次原子提交多个节点和边：先应用节点修改，再应用边修改，仅对整批最终状态运行一次相同的结构编译器；失败时保留原图并返回 saved topology 和诊断。保留单条 node/edge 接口用于增量修正。实际模型回合及耗时变化待复跑确认。

## 8. 证据索引

以下文件均位于证据根目录：

- `run-trajectory.jsonl`：阶段级墙钟轨迹
- `state-trajectory.jsonl`：每次运行状态变化
- `api-trajectory.jsonl`：采集器请求/响应
- `browser-trajectory.json`：前端请求、响应和 console
- `planning-partition.jsonl`：原始 Partitioner 事件
- `planning-planner.jsonl`：原始 Planner 思考、文本和工具事件
- `planning-analysis.json`：规划指标与 tool mutation
- `graph.json`：Planner 最终图
- `planned-snapshot.json`：审批前状态
- `snapshot.json`：发布后完整 metadata 状态
- `execution-*.jsonl`：5 个节点的原始执行轨迹
- `execution-analysis.json`：节点耗时、工具和 token 汇总
- `npm-test.txt`：独立全量测试输出
- `hidden-acceptance.txt`：隐藏行为验收
- `acceptance.json`：自动验收结果
- `final-assessment.json`：原始 harness FAIL 的人工裁决
- `01` 至 `04`、`06` PNG：工作区绑定、规划流、计划图、审批和完成态截图
- `05-parallel-execution.png`：运行态截图；本次截取时前端 snapshot 尚未同步后端已经派发的两个并行节点，并行结论以 `state-trajectory.jsonl` 中 parser/search 同为 running 且 `startedAt` 完全相同为准

## 9. 复跑方式

```sh
npm run build
$HOME/.cargo/bin/cargo build --manifest-path backend/Cargo.toml --bin grapher
set -a; source .env; set +a
node benchmark/e2e-full-chain.mjs
```

脚本每次创建新的 `benchmark-results/e2e-full-chain-<UTC>/`，不会覆盖旧证据，也不会修改 Grapher 仓库中的业务文件。

## 10. 修复后 Planner 单次复跑（2026-09-15 12:00Z）

### 10.1 范围与结果

证据目录：`benchmark-results/e2e-planner-rerun-2026-09-15T12-00-16Z/`。

本次仅运行真实 Planner，到生成图并完成最终结构编译为止。使用 `benchmark/planning-host.rs`，共享生产 Pi adapter、Planner prompt、工具扩展与 Rust 编译器；**不运行 Partitioner、浏览器、HTTP 审批、Node Agent、合并或发布，也不调用模型 judge**。因此这是 Planner 组件复跑，不是第二次全链路验收。

- 时间：2026-09-15 12:00:16.585Z 至 12:02:04.952Z；Planner host 内计时 107.870 秒。
- 模型：`dashscope/qwen3.8-flash`，thinking `medium`，单次样本，没有按结果重试整轮。
- 输入：复用原报告的完整用户目标；从原 fixture 基线 `a5433ce69809aa9b996724c0c984718325c37a9d` 恢复四个文件到新 Git 仓库，未使用上一轮已完成的实现。
- 修复状态：启用 `node / edge / read / bash` 和 `node` 批量参数；未启用新增 fidelity/economy 门禁、字数限制或 worker 范围限制。实际源码副本与 SHA-256 保存在证据目录。
- 结果：Planner 正常退出，最终图 **5 节点 / 5 边 / 4 层 / 0 warning / 0 diagnostic**；`planner-readonly-tools-v2` 边界检查 PASS。
- 隔离：节点执行数为 0；fixture HEAD 未变化，Git 工作树 clean。

```text
contract
  ├─ catalog-csv ─┐
  └─ search ──────┴─ integration ─ verification
```

图结构与七条路径的所有权符合目标；contract 为唯一 root，verification 为唯一 terminal，两个实现分支可并行，integration 依赖两者，没有额外 feedback 边。上述结论来自生成图与编译结果，不代表实现或测试已经通过。

### 10.2 实际工具轨迹

| UTC 时间 | 工具 | 行为与结果 |
| --- | --- | --- |
| 12:00:28.563 | read | 成功读取完整 `README.md` 权威契约 |
| 12:00:32.946 | read | 成功读取 `package.json`，确认 ESM 与 `node --test` |
| 12:00:36.553 | bash | 尝试 `ls -lah . && cat .gitignore 2>/dev/null; node --version`，受限解析器拒绝 |
| 12:00:43.932 | bash | 改为 `ls -lah .`，成功 |
| 12:01:01.209 | node | 创建 contract 时嵌入 Planner 仓库绝对路径，`workspace-portability` 拒绝，保存图仍为空 |
| 12:01:26.039 | node | 改用当前工作区描述，contract 创建成功 |
| 12:01:53.278 | node（批量） | 一次提交剩余 4 个节点和 5 条边，成功返回完整 4 层执行计划 |

共 7 次工具调用，2 次错误结果，模型均自行修正。没有放开任意 shell，没有越界读取或把被拒绝的 mutation 写入图。

**P0 工具恢复得到实际验证。** 本次先读到了权威 README；原报告中的无仓库检查能力已不再成立。

**P2 批量提交得到实际验证。** 模型并非完全逐条建图，最后一次 `node` 调用携带 `nodes[4]` 和 `edges[5]`，替代了原本需要的 9 次单项 mutation。整轮成功的图修改调用由原跑 10 次减少到 2 次；包含被拒绝的绝对路径提交则为 3 次 mutation 尝试。这里是工具调用层面的收益，不能等同于模型整体提速。

### 10.3 与原跑的指标比较

| 指标 | 原全链路中的 Planner | 本次 Planner-only |
| --- | ---: | ---: |
| Planner 耗时 | 87.902 秒 | 107.870 秒 |
| Assistant messages | 8 | 8 |
| 工具调用总数 | 10 | 7 |
| 成功图修改调用 | 10 | 2 |
| 图修改尝试（含拒绝） | 10 | 3 |
| 检查工具调用 | 0 | 4 |
| 工具错误 | 0 | 2 |
| Total tokens | 36,684 | 32,086 |
| 最终节点任务总词数 | 1,328 | 1,043 |
| 最终节点任务总字符数 | 10,614 | 8,126 |
| 单节点任务词数范围 | 231–289 | 172–241 |

任务总词数下降约 21.5%，字符数下降约 23.4%，total tokens 下降约 12.5%；耗时增加约 22.7%。本次 usage 为 input 9,791、output 3,607、cacheRead 18,688、cacheWrite 0；provider 另外报告 reasoning 645，未再加到 totalTokens 中。

两个样本使用相同目标和 fixture，但本次由 planning-only host 驱动，且存在缓存、服务延迟、模型采样及两次修正的影响。不能把变化全部归因于某一修复，也不能用一次样本证明稳定的性能提升。执行成本未测，不比较 worker token、测试规模或发布结果。

### 10.4 本次仍观察到的问题

以下记录具体证据，不据此新增 prompt 限制、审批门禁或自动改图。

**1. 受限 bash 使用方式仍会出错。** 已提供命令边界说明，模型仍提交组合 shell、重定向和白名单外的 `node --version`。解析器在执行前拒绝，模型下一次改成允许的单条 `ls`。这是一次可恢复的工具使用错误，并非权限边界失效；增加了一次失败往返。

**2. 节点任务仍可能引用 Planner 的绝对工作路径。** 第一次 contract 提交含新 fixture 的绝对路径，违反独立 worktree 的路径可移植性要求。守卫拒绝并返回空的 saved topology，模型重写成功。这增加了一次完整任务重发；最终保存图没有该路径。

**3. 读取权威契约后，仍主动要求消解未指定行为。** contract task 原文：

> Resolve every ambiguity in README.md into an explicit, testable statement (e.g. plain `Error` vs subclass, what "invalid numbers" covers, header-only input, blank/trailing lines) without contradicting README.md.

README 没有要求固定 `Error` 子类、header-only、空白/尾行等细节；该任务又将 `contracts/catalog.md` 设为下游 binding authority。因此“完全因为读不到 README 才出现规格扩张”的解释不足以覆盖本次现象。但 contract worker 尚未执行，不能声称这些要求已导致实现膨胀或契约冲突。本次不再出现原跑的 BOM、pagination、diacritic、locale 等扩展清单，也没有要求 duplicate rows 成功存活的直接冲突。

**4. 集成和验证任务仍有重复工作。** integration 在跨模块链路中再次覆盖 CRLF、quoted comma、escaped quote、边界相等、顺序与 non-mutation，这些也已分配给上游单测；verification 要求先 `npm test`，再逐个运行三份测试文件，并制作逐条契约覆盖表。部分内容可以作为端到端验收，但当前规划仍不是最少重复的任务安排。由于未执行，本次只能确认任务文本的重复，不能推断最终测试行数或额外耗时。

**5. 失败报告可能被当作节点完成证据，需留意与目标的关系。** integration 的完成证据写成“测试通过，或提供运行输出及契约违规列表”；verification 要求测试失败时记录失败，也以报告存在作为完成证据之一。用户目标仍是 `All tests must pass with npm test`。当前图没有授权这两个节点修改上游实现，也没有 feedback 边；如果执行时发现跨模块错误，该图如何继续达到“全部测试通过”并不由这份任务规格保证。这是生成图中的验收语义风险，未进行节点执行，不能判定实际会错误完成，更不据此擅自加 feedback 或放宽路径所有权。

### 10.5 证据索引与本次停止点

以下文件位于本次证据目录：

- `metadata.json`：时间、输入、基线、文件哈希、源码哈希、退出状态和 clean Git 结果。
- `planner-input.json`、`goal.txt`、`repository/`：准确输入与原始 fixture。
- `sources/`：运行时源码副本。
- `planner/stage.json`、`planner/system-prompt.txt`：实际模型、thinking、工具白名单及系统提示词。
- `planner/events.jsonl`、`planner/session/`：完整原始调用与会话证据。
- `planner/graph.json`、`graph-tasks.md`：最终图和便于阅读的节点任务。
- `planner/compiler.json`、`planner/result.json`：最终结构检查、模型总结与 host 耗时。
- `planning-analysis.json`：工具调用及结果、usage、前后规格指标、边界检查结果。
- `assistant-messages.json`：从原始事件提取的 assistant messages。
- `host.log`、`runner.mjs`、`analyze.mjs`：运行与分析辅助记录。

本次已在生成图及最终编译完成后停止；未审批、未执行节点，未修改产品实现来干预本次结果。旧全链路证据和原始 FAIL 元数据保持原样。

## 11. 对复跑问题的设计归因修正

第 10 节保留实际轨迹；对其中两次被拒绝调用和 feedback 缺失的解释修正如下，不把接口设计缺口直接归因于模型：

- `ls -lah . && cat .gitignore 2>/dev/null; node --version` 是普通只读检查，没有实际越权意图。旧检查接口拒绝的是组合语法和版本查询，其过窄的命令契约造成一次不必要往返。现支持 `&&`、`||`、`;`、换行、向 `/dev/null` 丢弃输出和 `node --version/-v`；原命令已作为回归用例通过。写入、任意脚本、越界读取仍按实际权限校验。
- Planner 实际系统提示词会暴露当前真实 checkout，但下游使用不同 worktree，随后再拒绝模型引用该路径，属于不一致的路径接口。现引入各 Agent 共用的 `/workspace` 可见命名空间：模型上下文、工具路径参数、命令中的字面路径及返回值双向映射；图任务中 Planner 的实际根路径归一为 `/workspace`，不再因这一表示方式拒绝整次 mutation。并行 Agent 的映射互相独立，不创建共用软链接。
- “只有用户明确请求重复审查修正才使用 feedback”限制来自 Planner 提示词，并非工具或 runtime 的能力限制。现删除该前提，允许有意义且有界的修正回路；评测器也不再仅因用户没明确说“循环”而拒绝 feedback。依赖祖先、实际职责和重试次数边界保留。

路径方案的目标在后续澄清为 Agent 接口层统一命名，而不是修改子进程的操作系统根目录。宿主知道每个实例对应的真实 worktree，可在工具入口映射，并让现有 Seatbelt 校验真实访问；不需要为了这个接口契约先引入容器。本次实现和验证见第 12 节。任意程序内部动态构造路径的行为仍区别于工具参数映射，不作为此次接口映射的完成前提。

已验证：原只读组合命令、条件分支、空设备重定向、写入/脚本/越界拦截、并行工作区路径映射、含空格和引号的真实路径、生产 worker 的 read/write/edit/bash、Planner 批量 mutation 与资源提取加载、feedback 评测策略。历史模型轨迹未改写；后续真实模型验证见第 12 节。

## 12. 统一 Agent 路径接口落地与复跑（2026-09-15 13:00Z）

### 12.1 实现与确定性验证

宿主在每次 `run_pi` 中根据当前请求固定 `GRAPHER_MODE` 和 `GRAPHER_WORKSPACE_ROOT`，覆盖外层遗留值。Partitioner、Planner、Node Agent、Merger 的模型可见工作区统一为 `/workspace`，实际执行目录、Git 操作、session metadata 和 sandbox 规则保持使用真实目录。

- `path / cwd / directory`、`paths` 数组在工具入口映射；相对路径仍按当前工作区解析。
- Worker shell 中的虚拟路径按本实例实际目录转换，处理空格、引号和嵌套字面 `sh -c` 脚本；不会建立所有 Agent 共用的软链接。
- Planner 的只读解析器直接解析 `/workspace`，在映射后执行原有仓库边界检查，不套用真实 shell 的转义。
- 模型上下文、工具输出及错误中的当前工作区路径映射回 `/workspace`；provider 签名、图片数据不参与文本替换，编辑/写入正文不作为路径参数改写。
- 图任务与边说明中出现的 Planner 真实根路径归一化保存，不再因为其路径表示拒绝 mutation。

验证通过：28 项 benchmark/检查接口/路径测试、生产扩展 smoke（含真实 read/write/edit/ls/bash、Planner 提取资源、Partitioner/Merger prompt 映射）、4 项 Pi 基线测试、Rust 全量测试及 15 项 UI 回归。新增 Rust 测试覆盖四种角色及错误环境覆盖；并行子进程测试证明相同 `/workspace` 指向不同实例文件；真实 Seatbelt 测试证明映射后的本目录读写成功、访问其他目录仍被拒绝。

### 12.2 真实 Planner-only 结果

证据目录：`benchmark-results/e2e-planner-workspace-2026-09-15T13-00-54Z/`。

沿用原报告目标、原始四文件 fixture、`dashscope/qwen3.8-flash`、thinking `medium`。运行当前 planning-only host，到最终图编译结束，不运行 Partitioner、浏览器、审批、节点或发布。源码副本和 SHA-256 记录在 metadata/sources 中。

- 时间：13:00:54.935Z 至 13:04:07.353Z，Planner 计时 **191.911 秒**。
- 正常退出，结构编译 PASS、0 warning、0 diagnostic，`planner-workspace-tools-v3` 边界检查 PASS。
- 图：**5 个节点，5 条普通依赖，5 条 feedback，4 层执行计划**。
- 工具：共 6 次调用（bash 4、read 1、node 1），2 次检查接口错误，0 次 mutation 错误，0 次路径映射错误。
- 一次 `node` 批量调用提交全部 5 个节点与 10 条边。
- Assistant messages 8；usage input 8,836、output 2,852、cacheRead 13,312、totalTokens **25,000**；provider 另报 reasoning 395，不重复累加。
- 节点任务合计 **856 词 / 6,406 字符**，单节点 156–191 词。
- 节点执行数 0，fixture HEAD 未变化、Git 工作树 clean。

普通依赖保持预期结构：

```text
contract → catalog ─┐
         → search ──┴→ integration → verify
```

feedback 为 `integration → catalog/search` 与 `verify → catalog/search/integration`，目标均为依赖祖先。删除“用户必须明确提出循环”的前提后，Planner 实际生成了有界修正路线，而非只要求最终报告失败。

### 12.3 路径与工具调用观察

1. 首次调用 `ls -la /workspace && cat /workspace/README.md && cat /workspace/package.json` 成功，实际读取权威输入，说明统一路径及组合命令支持生效。
2. 随后 `ls -lah /workspace/src /workspace; cat /workspace/src/* 2>/dev/null | head -50` 被不支持管道的检查接口拒绝。这里首先触发的是管道限制；该命令还涉及多路径 ls 和 glob，不能据此声称它们已经受支持。
3. `find /workspace -maxdepth 3 -type f && echo --- && ls -la /workspace/src` 在 `echo` 处被白名单拒绝，模型随后改用单独 find 成功。
4. `read` 使用 `/workspace/src/catalog.mjs` 成功读取 stub；生成图正常保存，没有再出现 `workspace-portability` 拒绝。

两次失败均为只读接口的兼容性不足，不是虚拟路径失效，也没有证据表明模型试图越权。本次保留运行时规则和原始轨迹，将管道、echo、多路径 ls 和 glob 支持记为接口待办，没有用新提示词要求模型绕开。

### 12.4 其他观察与结论边界

- 本次 contract task 主要转录 README 并命名验收用例，没有再要求“消解每个歧义”，也没有枚举之前的 Error 子类、header-only 或 blank/trailing-line 决策。单次变化不能证明行为已稳定收敛。
- 任务仍有重复验收内容，verify 仍包含全套和按文件执行、覆盖表；search 额外要求返回新数组。记录为文本观察，未推断实际实现或测试膨胀。
- feedback 增加了修正路径，但 runtime 在 `<REVISE>` 时会触发该来源的所有 outgoing feedback 目标，而不是根据 relation 文字只选择真正有问题的一个目标。本图的 integration 会同时触发 catalog/search，verify 会同时触发三个目标；实际重试成本尚未执行验证。
- 耗时较上一轮 107.870 秒增加，虽然 totalTokens 从 32,086 降到 25,000、任务词数从 1,043 降到 856，不能宣称整体提速。模型服务延迟、检查错误及采样均可能影响耗时，未作单因素归因。

本次完成标准是 Agent 工具接口统一路径与宿主映射，已用实际调用、并发和 sandbox 验证；未把它扩大为操作系统文件系统虚拟化，也未声称任意程序内部的动态路径都经过转换。

证据：`metadata.json`、`sources/`、`planner/events.jsonl`、`planner/session/`、`planner/graph.json`、`graph-tasks.md`、`planner/compiler.json`、`planner/result.json`、`planning-analysis.json`、`assistant-messages.json`。本次在图生成及最终编译后停止，未审批或执行节点。


