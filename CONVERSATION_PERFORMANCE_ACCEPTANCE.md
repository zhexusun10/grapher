# 会话性能优化：TC-01–TC-14 验收证据

## 结论与数据来源边界

2026-10-01 在 Windows 上运行 `npm run test:conversation-acceptance`，**14 项自动化检查全部通过，无跳过**，用时 178.618 秒。

这不等于声称找到并实测了原始的 720 MB 历史文件：

- 可用真实旧库是 **327,143,424 bytes / 311.99 MiB**，仍使用旧事件日志结构。
- 大库是从该真实旧库的 Finished 文本还原 **890,000 条冗余 Output** 得到的 **958.17 MiB 派生旧结构压力库**，不是原始 720 MB 文件。
- TC-01 同时覆盖真实副本与上述大库；如果验收要求必须使用某一指定的原始 720 MB 文件，其**来源要求仍待提供该文件后验证**，不能由派生数据替代。
- Worker 是实际启动、实际退出和实际强杀的 Node 进程，通过 fixture 后端执行；并非模拟终止回调，但也不代表真实模型服务商和生产沙箱验收。

所有迁移、删除、checkpoint 写入均在副本上执行。SQLite 使用只读源连接及 backup API，包括 WAL 一致性；副本的仓库、worktree、publication 路径重绑到隔离 Git 仓库。原库文件 SHA-256、大小、表集合及事件指纹在测试前后**完全一致**；原库没有新增 `execution_logs`，没有执行 migrate。

## 可复现命令

前提：项目依赖已安装，Rust/Git 可用，Python **3.11+**，有可用浏览器；源数据库须含所选历史 Run 和至少一份超过 20 MiB 的执行日志。完整测试必须使用新的空输出目录。

```bash
npm run test:conversation-acceptance
```

默认源为 `.grapher/events.sqlite`；默认创建 `.grapher/acceptance/<timestamp>/`，Windows 默认使用已安装的 Edge。Git Bash/Linux 可指定：

```bash
GRAPHER_ACCEPTANCE_SOURCE=/path/to/legacy/events.sqlite \
GRAPHER_ACCEPTANCE_DIR=/path/to/new-empty-acceptance-directory \
GRAPHER_BROWSER_CHANNEL=chrome \
npm run test:conversation-acceptance
```

无安装浏览器的 Linux 环境可先 `npx playwright install chromium`。本次仅验证 Windows，不宣称 Linux 实测通过。源数据库最好停止写入，以免外部写入导致前后指纹检查失败。

入口及测量实现：

- `scripts/conversation-acceptance.mjs`：真实 HTTP、浏览器、进程强杀、迁移与逐项断言；失败退出非零。
- `scripts/conversation-acceptance-db.py`：只读备份、派生数据、MD5/游标检查、禁止 JIT 更新事件的触发器及 Finished 提交触发器。
- `scripts/fixtures/conversation-acceptance-worker.mjs`：50,000 行 Unicode/ANSI stdout、退出码 13、阻塞等待强杀。
- `backend/examples/conversation_acceptance.rs`：release 加载测量、Rust 分配计数、实际日志字段反序列化计数；须启用 `acceptance` feature。
- `GRAPHER_ACCEPTANCE_DEBUG_SWITCH` / `GRAPHER_ACCEPTANCE_DEBUG_REMAINING` 只供局部排错，始终非完整通过，不能作为验收结果。

## 本次逐项结果

| 编号 | 检查与实测证据 |
|---|---|
| TC-01 | 真实副本与 958.17 MiB 派生旧库均未经 migrate 直接打开；各自 10 个 DAG 节点全部展开。检查首屏 skeleton、非空 transcript 和真实最终回复内容；每份完整 HTTP 文本及数据库重组文本的 MD5/字节数均匹配源文本。打开 DAG 时日志请求数为 0。指定原始 720 MB 文件的来源边界见上文。 |
| TC-02 | 实际 Worker 退出码 13、OS 强杀 Worker PID 8028、强杀正在执行的后端进程；随后 migrate 并重启。完整 stdout 源 MD5、已提交前缀及中断日志数据库 MD5 均匹配；同时覆盖无 Finished 的 legacy Failed 分片迁移。 |
| TC-03 | small/real/large 三份副本各连续执行两次 `npm run migrate`，第二次全部为 0 backfill/migrate/update/delete；`auto_vacuum=2`、`freelist_count=0`。大库从 JIT 前 **958.17 → 279.07 MiB，缩小 70.88%**；从 JIT 后重复存储状态计为 77.45%。已去重真实副本按 JIT 前大小计算只缩小 **10.55%**，不混淆这两种口径。 |
| TC-04 | 完整尾部 `\n── Final response ──\nACCEPTANCE_FINAL: complete worker response 完成🚀\n`；input=7、output=3、totalTokens=10；duration=1.217 秒，与实际 process_exited 的 elapsedMs/1000 相等。 |
| TC-05 | 实际 Worker 输出 50,000 行，共 9,100,848 日志字节。数据库 BEFORE INSERT Finished 触发器在提交瞬间检查最大 offset、全部字节数、stdout 尾标记及 Final response；不是仅在提交后拉取日志。 |
| TC-06 | 中文、🚀🎉 与 ANSI 文本经过 784 个 chunk；每块 UTF-8 字节长度不超过 32 KiB，offset 连续。重组 stdout 与生成源的 MD5 均为 `9bd1cd3f12e4cd28beb9db53b2f459b7`；整体 HTTP/数据库 MD5 相同，无新增替换字符。整体还含进程生命周期/最终回复，故其 MD5 不与 stdout-only 混用。 |
| TC-07 | 先 pin Service 再 HTTP delete_run；该 Run 日志行数为 0，再次 snapshot 不能复活旧缓存。页数 **5332 → 2872**，freelist=0；数据库文件 **21,835,776 → 11,763,712 bytes**，不是仅逻辑删除或仅配置 PRAGMA。另通过 Service 删除/清空缓存回归。 |
| TC-08 | Edge 中三会话实际点击 30 次，setTimeout 周期 50ms（真实调度时间在 frames.json）。CDP 记录 29 次 snapshot 和 1 次日志请求 `net::ERR_ABORTED`，代理确认旧日志请求取消。切换工作负载期间 RAF 采样 **1216 帧**，检测文本、容器尺寸、祖先可见性/opacity 与 Run 身份：空面板 0、串流 0，最终停在 gamma。初次 landing 入场动画不计入该切换窗口。不是逐像素视频差分。 |
| TC-09 | 迁移 890,000 条 Output 后，实际历史 Run 有 36 个业务事件、10 份真实 execution 日志；另克隆业务投影加入 10,000 个事件，总计 10,036 业务事件，并写入 1 个 checkpoint。首次和重复 30 次加载均满足 <50ms / <100ms，实际日志字段反序列化字节计数为 0；具体统计见下表。 |
| TC-10 | 两个同时发起的真实 HTTP get_execution_output 读取同一未迁移 execution；响应逐字段一致。143 个日志 chunk 的 MD5、总字节与源匹配，offset 无重叠，事件行数/指纹保持不变。 |
| TC-11 | legacy MergerFailed 在迁移前 HTTP/JIT、迁移后重启 HTTP/数据库均为 **33,044 bytes**，MD5 `129b85cf26f64940afb414701509a06a`。显式断言尾部 `\nMerger failed: unresolved fixture conflict\n`。 |
| TC-12 | 无 Finished 的 Failed 节点重启后 outputBytes=**144,198**；完整 HTTP/数据库字节与源匹配。浏览器选择 Failed 节点，向上导航到该次 Worker 的历史，实际显示其最终 assistant 文本，不被最新 merger 或空状态遮蔽。 |
| TC-13 | 单独执行并断言游标回归测试通过：连续多批、多个 execution 交错、UTF-8 页边界、数据库最大 offset 等于 live buffer 长度、关闭/重开恢复游标及删除级联。另由 TC-05/06 覆盖真实大量 stdout 的连续 offset。 |
| TC-14 | JIT 前后真实副本 37 行、大库 890,037 行，所有事件 SHA-256 均相同；整个 JIT 测试期间安装拒绝 events UPDATE/DELETE 的触发器。只有离线 migrate 清洗 Output/Finished 文本。 |

### TC-09 release 测量

Windows 10.0.26300 / x64，AMD Ryzen 7 9850X3D，约 32 GiB RAM；Node v24.16.0；Edge 154.0.4258.48。

| 数据 | 首次加载 | 重复 P50 | 重复 P95 | 重复最大 | 硬预算 | Rust 最大单次分配 | Rust 总分配峰值/次 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 实际日志迁移库，36 业务事件 | 2.349 ms | 1.509 ms | 1.588 ms | 1.638 ms | <50 ms | 65,683 bytes | 767,796 bytes |
| 10,036 业务事件 + checkpoint | 5.401 ms | 4.666 ms | 5.841 ms | 6.164 ms | <100 ms | 7,471,104 bytes | 18,391,788 bytes |

两组的真实日志字段反序列化计数均为 **0 bytes**。后者分配包含必须返回给前端的业务事件向量，而非日志。分配计数仅覆盖 Rust global allocator，不代表 SQLite C allocator 或完整浏览器堆画像；首次指 Store 实例首次 load，不宣称 OS 冷缓存测量。

## 验收发现并修复的遗漏

1. `VirtualizedTranscript` 原先将普通 stdout 算作 assistant 的流式前缀，导致 Failed 日志的 `message_end` 完整回复被吞掉。现在用 `rawOutput` 区分二者；补充普通 stdout 在回复之前、与 delta 交错的三个回归场景。
2. rusqlite `execute_batch` 对返回行的 PRAGMA 只 step 一次；原 `incremental_vacuum` 实际仅释放一页，且后续未 checkpoint 到物理文件。现在完整消费 PRAGMA，单次限定 **4096 页**（默认 4 KiB 页约 16 MiB），再 checkpoint。更大的删除余量留待后续维护，避免长时间锁住其他 Worker 的写入。

## 证据位置与其他回归

本次原始 JSON、所有数据库副本、浏览器截图/trace、网络取消及逐帧采样、两次迁移 stdout 保留于：

```text
.grapher/acceptance/2026-10-01T12-31-24-551Z/
  report.json
  manifest.json
  TC01-real.trace.zip / TC01-large.trace.zip
  TC01-<data>-<execution>.png
  TC08-frames.json / TC08-switching.trace.zip
  TC12-failed-after-restart.png / TC12-failed-after-restart.trace.zip
  TC03-<data>-migrate.txt
```

这些资料含原始历史日志，按 `.grapher/` 忽略规则留在本地，不提交到仓库。源文件 SHA-256 前后均为 `f835434669608974c1e85f5adb89ee25121323f2cad77751013515656db6515f`。

其他回归：前端 **55 passed**；fixture 后端 **187 passed / 1 ignored**（旧独立合成压测）；默认生产库 **79 passed / 1 ignored**（需真实 Pi warm-node slot 的测试）。类型检查、前端 build、默认 Cargo check 通过；这些 ignored 项不计入上述 14 项验收。

日志分别位于 `.grapher/acceptance-frontend-tests.txt`、`.grapher/acceptance-backend-tests.txt`、`.grapher/acceptance-production-tests.txt`、`.grapher/conversation-acceptance-run.txt`。
