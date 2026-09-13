# 只读 Bash 与评测边界修复

## 产品改动

Planner 恢复 `node / edge / read / bash`。Bash 是扩展覆盖的受限检查接口，不是放行 Pi 原生 shell：仅支持列目录、查找、搜索、读文件与公开 HTTP(S) 的 curl GET/HEAD。专用解析器不执行 shell；拒绝写命令、脚本、测试、重定向、管道、命令组合、仓库外路径、符号链接及 .git。curl 不使用本机配置、代理或认证信息，不允许上传和请求体；固定已验证公网 DNS 地址，每次重定向重验，禁止本机/内网及非默认端口。read 共享本地路径检查。

提示词明确只读工具能力及任务派发边界。工具权限属于可信扩展能力约束，不是操作系统沙箱；联网 GET/HEAD 也不能保证远端没有副作用。具体限制见 `backend/resources/planning-inspection.md`。

## Benchmark bug

1. 原先将 rubric 写在 fixture 父目录，但无限制 Bash 能读取它。现在 rubric 在候选阶段结束后才写入，且本地检查不能逃出 fixture，curl 不能通过本机/内网绕过本地边界。文件布局本身不作为隔离证明。
2. 原先仅检查最终 Git 状态和 Runtime 产物，漏掉临时写入、运行代码和读取隐藏评分标准。新增 `planning-boundary.mjs`：要求当前检查策略及实际工具执行证据；不完整、未验证、越界或旧无限制 Bash 证据在语义评分前失败。原始记录保留，不覆盖旧分数。
3. 工具错误可能在 `result.isError` 中，而外层 `isError` 为 false。统计现在兼容两者，分别记录检查拒绝和 mutation 拒绝，避免漏计。

## 实际验证

- `npm run test:benchmark`：16 个测试通过，含命令注入、危险参数、父目录和符号链接泄漏、curl 写操作/本机访问拒绝、DNS 固定和重定向、响应大小和超时、旧污染证据拒绝。
- `scripts/check-pi-extension.ts`：通过，包括实际扩展加载、Bash 覆盖、生产提取目录中的双资源加载、路径拒绝、图回滚和一次性路由。
- Rust benchmark 宿主与产品二进制构建通过；`npm run check` 通过。
- 真实 `curl -I https://example.com`（通过只读检查实现）返回 HTTP 200。

### 旧 P004 离线重算

`benchmark-results/readonly-boundary-replay-2026-09-13T07-30-55-919Z`

复用原 `planning-unrestricted-bash-2026-09-12T23-15-51-082Z` 的 P004，不调用模型。图仍编译通过，但因缺少只读策略证据且执行过无限制 Bash，判为 PLANNING_BOUNDARY FAIL，不再计质量 PASS，也不再调用 judge。该旧记录已确认读取隐藏 rubric 并执行临时探测代码。

### 新 P004 单次实跑

`benchmark-results/readonly-inspection-p004-2026-09-13T07-31-03-601Z`

实际模型 qwen3.8-flash，Planner-only 一次，未失败重采样。受限 Bash 确实生效；工具证据边界 PASS，fixture 仓库未变化。模型调用 bash 16 次、read 17 次、node 5 次、edge 2 次。三次 Bash 拒绝分别是 find 不支持的排除参数、ls -R、ls 多路径；这些结果的错误标志仅在嵌套 result 中，是上述统计修复的直接证据。

这次发生一次 provider 请求超时并重试，最终触及产品 900 秒上限（宿主记录 900704 ms），结果 ENVIRONMENT_FAILURE。保存的候选编译 PASS 不等于规划完成；未调用质量评审、不能报告规划成功或提速。原始 stage 指标生成于嵌套错误统计修复前；已在 `benchmark-results/readonly-metrics-replay-2026-09-13T07-52-01-572Z` 离线重算并断言 inspectionRejections=3，保留原超时 FAIL，没有新增模型调用。

本次没有重跑完整六题；不对规划质量或耗时作整体改善结论。
