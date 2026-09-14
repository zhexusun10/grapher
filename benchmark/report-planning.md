# B010 重设计：Partitioner 路由与 Planner 图质量

旧 B010 的“真实 Pi 写 hello.txt”实现已删除。默认 `npm run benchmark` 现在评估 Partitioner／Planner；B001–B009、B011 单独保留为 `benchmark:runtime`，不参与规划质量得分。

本轮已经实际调用模型完成六个路由任务、生成三张完整候选图，并用修正后的评分器评估这些图。**路由判断 6/6 正确，单次 route_task 协议 3/6 遵守；三张图均编译通过，质量检查通过 2/3。所有样本的节点执行次数都是 0。** 这些是少量固定任务的观察结果，不是一般任务成功率。

## 执行边界

新的 `planning-host.rs` 复用产品 prompts、真实 Pi 工具扩展、逐次 mutation 的编译器与最终编译器，不创建 Runtime，不调用审批、drive、perform 或 worktree 准备。模型只做路由与图设计。语义评审是另外一个无工具、无历史上下文的模型进程。

每个任务使用独立的可读 Git 仓库。预期路由、任务评分标准保存在仓库外，候选模型不会收到它们。Planner-only 模式直接评估三个图任务，完全不调用 Partitioner。

## 任务集与路由结果

| ID | 任务 | 预期 | 实际 | route_task 次数 |
|---|---|---|---|---:|
| P001 | 单函数邮箱规范化修复及测试 | serial | serial | 1 |
| P002 | 同一 CSV 导入函数中的顺序性改进 | serial | serial | 2 |
| P003 | 跨后端、前端和文档的机械字段重命名 | serial | serial | 4 |
| P004 | 已有契约下的后端、浏览器功能与集成验证 | graph | graph | 1 |
| P005 | 重试契约、双语言 SDK、一致性审查与反馈 | graph | graph | 1 |
| P006 | 身份认证审查、存储审查与发布决策汇总 | graph | graph | 3 |

路由准确率与协议遵守率分开计算：重复作出同一个正确判断不应被记成路由误判，但仍违反产品提示中的“exactly once”，导致该样本整体失败。

[路由重算结果](../benchmark-results/planning-baseline-regraded-2026-09-12T22-38-28-312Z/summary.json) 使用原始模型输出，没有重新调用 Partitioner。

## Planner 图质量结果

| ID | 节点数 | 普通／反馈边数 | 真实编译器 | 语义评审分 | 最终质量检查 |
|---|---:|---:|---|---:|---|
| P004 | 4 | 3／5 | PASS | 10/10 | **FAIL：绑定原始仓库绝对路径** |
| P005 | 4 | 4／2 | PASS | 10/10 | PASS |
| P006 | 3 | 2／2 | PASS | 10/10 | PASS |

P004 的四个节点都要求 worker 在这次 benchmark 的原始仓库绝对路径工作。实际 Grapher 会给每个 execution 分配独立 worktree，这种任务指令会把 worker 引回原仓库，破坏执行隔离。这是图编译通过后仍存在的设计缺陷，`workspace-portability` 确定性检查将其判为失败。

P005 的图是：契约节点 → TypeScript／Python 两个独立实现 → 一致性审查；审查分别反馈到两个实现节点。任务明确引用契约文件、限定各自输出文件、列出测试要求，符合本题的依赖和反馈约束。

P006 的图是：身份认证／存储两个独立审查 → 发布决策汇总。三个节点分别写不同报告，汇总节点依赖两个上游报告，并保留评审缺口的反馈路径。

模型语义评审对三张图都给出了满分，漏掉了 P004 的路径问题。因此最终质量判定必须同时满足语义评分与确定性检查。当前语义评审仍偏宽松、没有用独立人工金标校准，不能把 10/10 当作图完美的证明。本人另检查了实际图和节点任务，确认上述路径缺陷及 P005/P006 的结构、文件边界。

[最终评分 summary](../benchmark-results/planning-final-2026-09-12T22-48-44-756Z/summary.json) · [P004 图与失败证据](../benchmark-results/planning-final-2026-09-12T22-48-44-756Z/P004-1/result.json) · [P005 实际图](../benchmark-results/planning-final-2026-09-12T22-48-44-756Z/P005-1/planner/graph.json) · [P006 实际图](../benchmark-results/planning-final-2026-09-12T22-48-44-756Z/P006-1/planner/graph.json)

## 评分设计

- 真实编译器检查结构合法性，不把编译成功直接当作质量成功。
- 语义评审检查目标覆盖、独立可执行的任务指令、职责划分、可合并性、验证要求，五项各 0–2 分；最低 8/10，任何一项为 0 都不通过。
- 评审根据带行号的任务原文返回证据位置，评分器提取原始行。无效节点、越界行号、虚构或改写的引文会成为 `JUDGE_FAILURE`。
- 确定性检查产出责任与路径、前置依赖可达性、独立分支是否被强行串行化、指定反馈路径、节点规模与 worktree 路径可移植性。
- 不要求固定节点名称或逐字匹配某张标准图；接受传递依赖。
- Partitioner 误把图任务路由为 serial 时，仍独立评估 Planner，分别报告能力；路由错误不会被 Planner 的成功掩盖。

## 开发阶段发现的 benchmark 问题

原始记录全部保留，未用后来的评分覆盖原始失败：

1. 初稿把“路由正确”和“只调用一次工具”合成一个指标，错误显示为路由 3/6。已拆分指标并增加回归，按相同输出重算为路由 6/6、协议 3/6。
2. 初稿沿用 240 秒宿主超时，P004/P005 在规划未结束时被中断。这是 benchmark 预算设置不适合本次 Planner 任务，不能据此判断图质量。现已使用产品的 900 秒 Pi 上限，加 30 秒宿主清理余量。
3. 初稿要求模型给逐字引文，评审却用省略号拼接段落，严格校验拒绝了这些输出。现在让评审引用原文行号，由评分器提取文字。没有放宽“证据必须来自实际任务”的要求。
4. 图生成暴露了绝对路径绑定缺陷，新增确定性检查以及“编译器和语义评审都给正面结果时仍必须失败”的反例。

[初稿原始结果](../benchmark-results/planning-baseline-2026-09-12T22-18-25-010Z/summary.json) 与 [修正时间预算后的候选图](../benchmark-results/planner-budget-corrected-2026-09-12T22-27-11-822Z/summary.json) 是不同采样批次。最终三张图来自后者；该批次仍使用旧评审格式，原始 `JUDGE_FAILURE` 保留。

[新版评审](../benchmark-results/planning-final-review-2026-09-12T22-45-08-510Z/summary.json) 对保存的三张图各进行一次评审，没有重新生成图。[最终离线重算](../benchmark-results/planning-final-2026-09-12T22-48-44-756Z/summary.json) 使用同一批候选和评审，没有新增模型调用。`evidenceRun` 保存原始证据链，`sourceSha256` 和 `gradingVersion` 标记各次评分代码。

候选 Planner 的实测耗时为 P004 422.418 秒、P005 261.451 秒、P006 157.643 秒。各阶段保留模型、token 和工具调用指标；token 包含模型报告的 cache usage，不作独立计费推断。评审耗时/用量与候选生成分开保存。

## 本轮问题诊断与修复

检查原始 `partition/events.jsonl` 后，重复调用可定位为模型的连续新响应，不是宿主重试：P002/P003 每次都已收到成功工具结果，仍分别调用 2/4 次；P006 实际是 `graph → serial → graph`，并非始终重复同一判断。旧扩展每次覆盖 route.json，工具一直可用，“Finish your response now”只是文字提示，没有协议状态约束。

修复：`backend/resources/planner.ts` 在第一次成功保存路由后撤下全部工具，并用闭包状态拒绝后续调用覆盖（也保护同一响应内的重复调用）；Partitioner prompt 明确成功后只回复 Done。撤下工具防止后续轮次继续调用，但不宣称能阻止模型在首次响应里生成多个调用；评分器仍保留独立协议指标。

Planner 的“效果不佳”需要区分质量与耗时，不能由这三例推断一般能力低：最终图均编译成功，P005/P006 质量通过；P004 确认存在隔离缺陷。原始成功生成批次中，P004/P005/P006 分别有 33/22/23 次工具执行，其中 Bash 被拦截 4/2/2 次，P006 另有两次 read offset 类型错误。旧 prompt 没有提前说明 Bash 白名单，模型靠失败结果才知道限制。P004 的任务还复制了大量实现细节和规划目录；每次 mutation 又返回完整累积图，增加上下文与输出负担。这些是可观察的开销来源，不是已通过消融实验量化的耗时归因。240 秒初稿超时则是预算问题，不是编译器拒绝图。

修复：Planner prompt 提前说明 inspection 工具限制、要求精简但自包含的任务、引用既有契约、避免不必要的实现 API 设计；明确规划目录仅用于检查，worker 必须留在分配的 worktree，任务使用仓库相对路径。扩展在写入节点前检查当前规划仓库路径及其 realpath，命中即返回 `workspace-portability` 错误且不改候选图，让模型修正。此检查针对 P004 的原仓库路径泄漏，并非通用自然语言路径安全证明；没有禁止合法的外部绝对路径，也没有自动改写任务含义。

验证：`scripts/check-pi-extension.ts` 通过，新增路由撤下工具/拒绝覆盖、绝对目录及目录下文件路径拒绝与回滚、相对路径接受回归；`npm run test:benchmark` 的 10 个评分器测试通过。尚未重新调用模型，旧候选图和分数保持不变，不能宣称修复后路由协议率或生成质量已经提高。

### 后续调整：放开 Bash

按后续要求，已移除 Planner Bash 命令白名单及对应提示词段落，统一使用 `node agent` 术语，不再新增 `worker` 称呼。上文的白名单说明记录此前修复阶段，不代表当前权限。当前仅 read 工具保留仓库范围检查；Bash 不受该检查限制，因此规划只读是提示词约束，不是强制安全边界。原有 bench 数据来自调整前，未重跑模型。调整后的扩展 smoke 测试及 10 个评分器回归测试通过。

## 验证与复现

评分器的 **10 个回归测试通过**，覆盖有效图、传递依赖、缺失依赖、无谓串行化、单节点关键词堆砌、漏产出、编译拒绝、伪造证据、行号取证、原始仓库路径绑定、路由/协议分离及反馈要求。Rust benchmark 宿主构建通过；改动后的 runtime 适配器另做了 B005 兼容性检查，不计入 Planner 得分。

最终验证还逐条检查了评分证据的行号与原文一致，确认所有 fixture 的 Git 状态与 HEAD 保持不变、没有 execution artifacts，最终离线重算中的各阶段均标记 `replayed: true`。

```sh
npm run benchmark                    # 6 个路由任务，3 个图质量任务
npm run benchmark:planner            # 仅 Planner：3 个图任务
npm run benchmark -- --task P005      # 单任务诊断
npm run benchmark:validate           # 每个任务固定采样 3 次
npm run test:benchmark               # 评分器回归，无模型
```

只重算现有数据：

```sh
npm run benchmark -- --planner-only --replay benchmark-results/planning-final-review-2026-09-12T22-45-08-510Z
```

`--rejudge` 会仅调用新的语义评审，复用候选图。`BENCHMARK_PI_MODEL` 选择待评估模型，`BENCHMARK_JUDGE_MODEL` 可以单独选择评审模型。本次实际使用 `qwen3.8-flash`。完整设计见 [architecture.md](architecture.md)，候选/评分边界见 [system-under-test.md](system-under-test.md)。
