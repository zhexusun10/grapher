# Harbor → Grapher adapter

`benchmark.harbor_agent:GrapherAgent` 是 Harbor 的 **custom installed agent**，无需将 Harbor 源码复制到本仓库。Harbor 进程需能从 `PYTHONPATH` 导入此模块；`benchmark/run.py` 会被上传并在每个 Harbor task 环境内运行。使用 Harbor 0.23.0（已在独立 checkout `31668af15560fb50a9d0584816d12726036656cf` 上验证 Python 3.12 自定义 agent 接口）。测试：`python3 -m unittest discover -s benchmark -p 'test_*.py'`（无 Harbor 时会跳过 import-path 接口测试；真正的 Linux/Harbor 容器验收另见下文）。

## Linux Graph 隔离环境要求

Linux Graph 节点使用 **bubblewrap (bwrap)** 创建每实例 user/mount/PID namespace：只回挂当前私有 Git 仓库与当前 session；源目录、其他工作区及 Grapher 数据库由空的只读挂载遮蔽，引擎副本及原始 Grapher 安装目录只读，保留任务容器网络供模型认证使用，并显式回挂容器自身的 `/dev`（否则嵌套挂载可能使 Git/Pi 无法打开 `/dev/null`）。**Harbor 的外层任务容器不等于节点隔离**。请在任务镜像内安装 `/usr/bin/bwrap`（bubblewrap），并确保容器安全策略允许非特权 user/mount/PID namespace 和 bind/proc mount；适配器安装和 Grapher Graph preflight 会执行真实 bwrap 探测（包括 `/dev/null` 读写），失败即停止，不会强制 Serial 或使用 fixture 绕过边界。某些默认 Docker/云环境会禁用 user namespace，必须调整任务环境策略（不是把 Grapher 图节点改为无隔离）。

**验收状态：** 当前主机是 Apple Silicon macOS，通过 Colima 的真实 Linux VM（配置 `tb4-compose.yaml` 授予命名空间权限）运行：`linux_sandbox` 5 项隔离测试、双节点原生 Pi 测试、Harbor 0.23.0 `--install-only`，以及 Harbor Docker task 中的 Auto→Graph→Planner→bwrap 节点→发布→verifier 全链路均已打通，并已通过真实模型完成端到端冒烟验证。Colima 的 Docker task 需要允许嵌套 namespace（本机 overlay 使用 `SYS_ADMIN`、`seccomp=unconfined`、`apparmor=unconfined`、`systempaths=unconfined`）；这是一项本地 Linux VM/容器策略前提，不应当作通用多租户安全配置。目标 Harbor 镜像仍需按其实际安全策略复现。

## 准备环境

在 **每个 task 环境内部**（不是 Harbor 所在机器）预装 Grapher 到 `/installed-agent/grapher`：包含可执行的 `backend/target/release/grapher`、本仓库的 `engine/`、`scripts/`、**锁定的** `pi/` 子模块及编译后的 `pi/node_modules/`。可用 `docker build -f benchmark/Dockerfile --build-arg GRAPHER_COMMIT=<固定 SHA> -t grapher-harbor:<SHA> benchmark` 创建无本地密钥/脏文件的基础镜像，再基于它构建所需任务镜像（不可抹去任务原有依赖）；如果与其他 harness 比分，任务镜像及可访问工具必须一致。非 root 任务用户还必须能读写安装目录所需的 Pi 配置，并使 Git checkout 可信。或者在 task 镜像构建阶段通过固定的 Grapher Git commit 和 `git submodule update --init --recursive` 获取代码，安装 Node.js 22.19+、稳定版 Rust、Git（需支持 `--path-format=absolute`）、C 编译工具链与 bubblewrap，再运行 `npm run pi:setup` 和 `node scripts/cargo.mjs build --release --manifest-path backend/Cargo.toml --bin grapher`。不要将本地 `.env`、令牌或不受控的全局 Pi 打包进去。`install()` 会校验 Linux bwrap、锁定 Pi、checkout 清洁状态及二进制内嵌 Git commit 与源码一致，并将该 commit 记录为 Harbor agent version；不在计时中的 trial 阶段下载/编译代码。可用 `--ak grapher_root=/absolute/path` 指定另一位置。

将 Harbor task 的 `environment.workdir` 设置成任务项目根目录（Grapher 直接编辑该目录；普通文件夹可由 Grapher 创建外置 shadow Git）。需允许访问模型服务商，按 Harbor 规范用 `--agent-env` 传认证。示例（在 Grapher 仓库根目录运行、Harbor 单独安装）：

```sh
PYTHONPATH="$PWD${PYTHONPATH:+:$PYTHONPATH}" harbor run \
  -p /path/to/harbor/tasks \
  -a benchmark.harbor_agent:GrapherAgent \
  -m anthropic/claude-sonnet-4-5 \
  --agent-env ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  --ak thinking=medium --ak max_parallel=4 --ak timeout_sec=28800
```

按模型替换 `-m` 和认证变量；模型名必须是锁定 Pi 内置的 `provider/model`。服务商自定义 endpoint 需经 Harbor `--agent-env` 显式传对应 base URL/认证；benchmark 模式禁止从宿主 `~/.pi/agent/models.json` 或安装目录 `.env` 偷偷继承自定义模型/端点（未经安装适配的全新 provider 不在支持范围）。Harbor 的 trial 超时需大于 `timeout_sec`（另留安装、启动和日志同步时间）。

## Terminal-Bench 4.0 本机运行记录

`benchmark/tb4.py` 是本机 Harbor 0.23.0 的可重复启动器。TB4 66 题的原始 `agent.timeout_sec` 均为 **28800 秒**，正式运行器及适配器默认值均应使用 28800（Harbor 外层超时额外预留清理时间）。此前 `~/.local/share/grapher-tb4/results/2026-09-28__16-58-06/` 误设为 3600 秒，已于第二题执行期间取消，**仅保留作诊断，不可并入标准时限成绩**；原始 job lock、超时 trial trace 和取消日志保持不变。`benchmark/tb4.py`：`python3.12 -m benchmark.tb4 smoke` 用 **真实** `terminal-bench/terminal-bench@4.0.0`（66 个任务）中的 `bun-sourcemap-leak` 做端到端验收；确认 `agent/result.json`、verifier 结果和 `trace-manifest.json` 全部可读且文件哈希正确后，运行 `python3.12 -m benchmark.tb4 all` 才启动全量（单任务并发、单次尝试、不重试）。记录分别位于 `~/.local/share/grapher-tb4/{smoke,results}/`，每次调用的 `invocation-*.json` 记录固定模型、`thinking=max`、Harbor / Grapher / TB4 的固定 commit、镜像策略、适配器和工具 SHA、预算和参数（**不包含密钥**）；Harbor `lock.json` 记录每个 task 的实际不可变 digest，试验目录保留 verifier、终态和 Pi 逐轮 trace。失败 trial 必须计入总成绩，不能排除环境异常后仍称全量成绩。

ARM64 Colima **不能**在 Harbor 提供的预编译 AMD64 任务镜像（QEMU）中使用嵌套 user namespace；启动器指定 `--force-build` 本机构建任务的 ARM64 镜像，`benchmark/tb4-compose.yaml` 为任务容器授予本机命名空间权限。安装时对缺少 `git` / `python3` / `bwrap` 的 Debian 任务镜像用 `--ak bootstrap_debian_tools=true` 在**计时前**安装；非 Debian、非 root 或 ARM64 不能构建的任务会显式失败，而不是悄悄放弃隔离。Node 22.19 二进制及编译好的 Grapher 只从之前经审计的固定镜像提取，分别以只读宿主目录 `~/.local/share/grapher-tb4/{toolchain,installed}` 挂入，不包含宿主 `.env` 或 Pi auth。密钥由启动器从 `~/.pi/agent/auth.json` 读入进程环境，仅按 Harbor 的 ModelConnectionSpec 传给 agent，不出现在命令行或持久化配置；切勿把 `invocation` 记录当作可获取密钥的方式。Grapher 的二进制内嵌 SHA 以当次 `invocation-*.json` 记录为准（会随构建提交变化，本文不复述具体值），固定 Pi 基线的 commit 由 `engine/pi-lock.json` 锁定。TB4 上游 Git tag `v4.0.0` 是 `452bf305c6daa62fc59061d22133a7cbc7c1572e`，**但上游 Git tag 的 `tasks/dataset.toml` digest 与 Harbor Hub 实际发布的 `@4.0.0` 包 digest 不相同**，不能使用 Git tag 的任务哈希替代成绩对应的 Harbor job `lock.json` 哈希。例如 `bun-sourcemap-leak` 上游清单为 `ac0b0f77...`，实际 Hub 锁为 `e55ae542...`。其他 harness 对比时必须使用**同一** TB4 task digests、构建架构、工具/权限、预算、模型端点、并发和重试策略；本机容器策略不是通用安全建议。

## 可比性与终态

每个 trial 启动私有 loopback backend、数据目录和 Pi 配置目录，直接把 Harbor 原始 instruction 送给 `plan_goal`，**不传 mode**，让 Partitioner 选择 Serial/Graph；配置强制 `autoApprove=true`，编译通过后自动审批 Planner 图（旧后端仍待批时调用 `control approve`）。Partitioner、Planner、NodeAgent、Merger 的模型环境覆盖统一设为 Harbor `-m` 的值；不支持隐藏的 role model 改写。Serial/Graph 只有全部节点完成，Graph 还需成功发布到任务目录，才视为成功。失败、卡住、超时不伪装成成功。

Harbor 的评分仍由其原任务 verifier 决定；此适配器不写 verifier 文件，也不读取 expected answer。Agent 超时/取消会终止 backend 及其子进程；Linux runner 在被强制杀死时还设置 backend 的 parent-death signal，防止延迟写入干扰 verifier。后端 stdout/stderr (`agent/backend.log`)、完整终态或最后一次快照 (`agent/snapshot.json`)、`agent/result.json`（runId、route、模型、planning/run metrics 或失败原因）以及 `agent/trace/`（所有规划尝试和 Partitioner/Planner 会话、节点 Pi 会话、Merger 输出、停机后从 WAL 一致性备份的 `events.sqlite`）保存在 Harbor trial 日志目录；`agent/trace-manifest.json` 记录文件大小和 SHA-256。为避免混入任务代码/密钥，不复制 shadow Git、Pi 凭证目录或软链接。日志可能含完整提示、模型回复和工具输出，须按敏感数据管控；若 Harbor 配置 `include_logs`/`exclude_logs`，确保不排除上述路径。日志归档失败会令 trial 失败。**不要把 `NODE_TLS_REJECT_UNAUTHORIZED=0` 等极短字符串作为 `--agent-env` 值传入**：Harbor 会在宿主日志中按环境变量值全局打码，可能把 JSON 数字中的 `0` 替换成 `[REDACTED]`，导致指标/日志 JSON 无法解析；本地 mock TLS 烟测使用 `NODE_EXTRA_CA_CERTS` 指向任务镜像中的测试 CA。成功时会把 Grapher 的 Pi token usage 映射到 Harbor 的 AgentContext（输入包含缓存读写，缓存单独记账；不伪造费用）。对比其他 harness 请固定相同的数据集版本、任务镜像（含 namespace 权限）、模型**及服务商/endpoint**、密钥权限、预算、并发和重试策略；并记录 Graph 平台失败，不能只挑 Serial 样本报告成绩。单 task Harbor 冒烟验收保存在 `~/.local/share/grapher-harbor-log-retention-ca/2026-09-26__12-19-52/`：本地协议 mock（**不是真实模型成绩**）选 Graph、自动批准并发布，verifier reward=1.0；Harbor token usage 可解析，537 项 trace manifest 校验全部通过，SQLite 含 36 条事件。本机 Colima 需将 Harbor `-o` 指向 Docker 可挂载的宿主目录（这里用 `~/.local/share/`），否则 `/private/tmp/` 不共享时日志/验证器文件可能无法同步。
