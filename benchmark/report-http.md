# HTTP 版本 benchmark 与修复报告

2026-09-13（artifacts 使用 UTC 时间）。本轮已完整阅读 `agent.md`，检查 benchmark 实现与历史记录，先运行修改前基线，再增加失败回归并修复。**确定性测试通过；完整验收 FAIL，因为固定三个真实 Pi 样本中一个遇到模型服务 HTTP 503。** 原始失败保留，未用补跑成功替换失败。

## 修改与证据

| 项目 | 发现、处理与验证 |
|---|---|
| 规划失败丢失诊断日志 | `plan_goal` 在 `run_pi(...)?` 处提前返回，后面的 JSONL 写入不会执行。现在先保存进程结果与日志，再传播错误；Partitioner/Planner 都修复。 |
| HTTP 未纳入完整 benchmark | 新增确定性 B011，复用 `scripts/test-http.mjs` 启动真实 HTTP 后端，验证静态资源、请求校验、编译、审批、执行、重启回放、规划失败和历史删除。全套现在是 10 个确定性场景 + B010。 |
| 失败路径缺少回归 | 通过实际 shell 子进程分别使 Partitioner、Planner 失败；断言日志保存退出原因、规划锁释放、原图和历史不变。脚本不调用模型，不计入真实模型成功率。 |
| benchmark 可出现空集合/不变量假通过 | 拒绝 `--case B010 --deterministic`；PASS 必须有快照且 execution 有结束时间、节点不再 running。验收检查完整用例集合，并比较进程、规划、重试和 runtime invariants。 |
| 可移植性和文档 | Pi 的 Node 默认命令从 Homebrew 绝对路径改为 PATH 上的 `node`；更新当前系统边界文档，区分 dispatcher 桥接与真实 HTTP，保留历史桌面报告。 |
| HTTP 脚本诊断与清理 | benchmark 模式保留请求/响应、快照、SQLite、worktree、规划日志和后端输出；独立运行仍清理临时目录。增加请求超时、启动错误处理和退出等待上限。 |

修复前回归：[http-planning-before-2/host.log](../benchmark-results/http-planning-before-2/host.log) 明确显示 `partition.jsonl` 不存在。请求已收到预期规划失败，缺失的是诊断文件。首次构建回归时传了 fixture Config 中的空 repository，见 [http-planning-before/host.log](../benchmark-results/http-planning-before/host.log)；这是测试输入错误，改为实际 fixture 仓库后才得到有效产品回归，不将第一次报错误判为产品缺陷。

修复后定向 B011：[http-diagnostics-fixed summary](../benchmark-results/http-diagnostics-fixed-2026-09-12T21-52-54-022Z/summary.json)。后续完整套件还增加了 planning guard 释放断言。

## 本轮运行结果

| 批次 | 确定性 | 真实 Pi | 全部样本 | 总耗时 |
|---|---:|---:|---:|---:|
| 修改前基线，原有覆盖 | 9/9 | 1/1，graph-ir | 10/10 | 45.692 s |
| 扩展后 repeat-1 | 10/10 | 未运行 | 10/10 | 34.842 s |
| 扩展后 repeat-2 | 10/10 | 未运行 | 10/10 | 30.051 s |
| 扩展后 repeat-3 | 10/10 | 未运行 | 10/10 | 30.141 s |
| 扩展后 final | 10/10 | 2/3，planned | 12/13 | 170.743 s |

[修改前基线](../benchmark-results/http-baseline-2026-09-12T21-49-34-628Z/summary.json) · [完整 final](../benchmark-results/final-2026-09-12T21-56-54-899Z/summary.json) · [验收记录（FAIL）](../benchmark-results/acceptance-2026-09-12T21-55-19-556Z.json)

新增 B011 和前端构建改变了套件覆盖和耗时组成；这些批次不是同条件性能对比，不声称项目执行速度提升。

三轮确定性和 final 中的确定性子集具有相同状态及逻辑指标：每套 32 次 node attempts、5 次 node retries、5 个 Pi-command 进程、4 个预期非零退出、2 次 Partitioner 和 1 次 Planner 调用。后面三个规划调用来自 B011 的确定性 shell fixture；4 个非零退出分别是 B006/B008 的 `/usr/bin/false` 和 B011 两个失败脚本。

四套 source SHA-256 均为：

```text
7120cafd005eaa75784e0e63520b64620ec9fa5c8bba2cff942921df7a6a1131
```

`validate.mjs` 在 final 失败后按原有顺序提前退出，没有到达跨套件比较步骤。本轮另外读取四份 summary，明确验证状态、attempts/retries、进程与规划调用、provider retries、runtime invariants 和源码 hash 一致；证据保存在 [verification.json](../benchmark-results/http-verification/verification.json)。这不改变完整验收 FAIL。

## 真实 Pi 失败分析

三个 final planned samples 使用 `qwen3.8-flash`，全部经过真实 Partitioner 并路由到单节点执行，没有调用真实多节点 Graph Planner：

| Sample | 状态 | 耗时 | Provider retries |
|---|---|---:|---:|
| 1 | FAIL，服务返回 HTTP 503 | 77.673 s | 3 |
| 2 | PASS | 41.397 s | 3 |
| 3 | PASS | 21.567 s | 0 |

Sample 1 的错误是 `OpenAI API error (503): Service temporarily unavailable`。Runtime 将 execution 记录为失败，保存结束时间，graph 进入 `needs_attention`；`runtimeInvariants` 为 PASS，任务成功状态仍为 FAIL。Sample 2 在 provider 自动重试后成功。

现有 runner 的粗粒度自动分类把 sample 1 记为 `AGENT_FAILURE`；本轮审阅分类是 **ENVIRONMENT_FAILURE（上游模型服务暂时不可用）**，依据是持久化的明确 HTTP 503。原始 summary 未重写，审阅分类单独保存在 verification.json。这次结果不能证明失败样本的任务完成，也不能以两个成功样本宣称完整验收通过。

[失败样本结果](../benchmark-results/final-2026-09-12T21-56-54-899Z/B010-1/result.json) · [失败状态与原始事件](../benchmark-results/final-2026-09-12T21-56-54-899Z/B010-1/snapshot.json)

## 补充检查与覆盖限制

- `npm test`：16 个 core + 5 个 engine 测试全部通过，见 [unit.log](../benchmark-results/http-verification/unit.log)。
- `cargo check --manifest-path backend/Cargo.toml`：通过，见 [cargo-check.log](../benchmark-results/http-verification/cargo-check.log)。
- `npm run test:http`：包含 TypeScript/Vite 构建与独立 HTTP 回归，全部通过，见 [test-http.log](../benchmark-results/http-verification/test-http.log)。独立模式也验证了临时目录清理路径。
- Vite 仍提示主 JS chunk 560.25 kB 超过 500 kB；本轮未调整分包阈值或以消除提示冒充性能优化。
- B008 是实际前端 action/service/type/render 合约，但 transport 仍为 dispatcher bridge；B011 经过真实 HTTP，未自动操作浏览器点击或 React effects。
- 本轮没有验证真实多节点 Planner 的生成质量、长期负载或任意任务成功率。规划日志仍在调用结束后落盘，突然杀死进程时不保证保存缓冲内容。

生产与测试代码在上述四套验收期间未变化；本报告与 README 的报告链接在验收之后补充。以前的 baseline/final/report/findings 以及历史 artifacts 均保留。

## 复现

```sh
npm run benchmark -- --deterministic
npm run benchmark -- --case B011 --label http-check
npm run test:http
npm run benchmark:validate
```

前三条不调用模型。完整验收使用固定三个真实 planned Pi 样本，需要现有模型认证和可用的上游服务；本轮没有继续重复模型样本来覆盖 HTTP 503 的失败记录。
