# Harbor → Grapher adapter

`benchmark.harbor_agent:GrapherAgent` 是 Harbor 的 **custom installed agent**，无需将 Harbor 源码复制到本仓库。Harbor 进程需能从 `PYTHONPATH` 导入此模块；`benchmark/run.py` 会被上传并在每个 Harbor task 环境内运行。使用 Harbor 0.23.0（已在独立 checkout `31668af15560fb50a9d0584816d12726036656cf` 上验证 Python 3.12 自定义 agent 接口）。测试：`python3 -m unittest discover -s benchmark -p 'test_*.py'`（无 Harbor 时会跳过 import-path 接口测试；真正的 Linux/Harbor 容器验收另见下文）。

## Linux Graph 前提（影响成绩）

Linux Graph 节点使用 **bubblewrap (bwrap)** 创建每实例 user/mount/PID namespace：只回挂当前私有 Git 仓库与当前 session；源目录、其他工作区及 Grapher 数据库由空的只读挂载遮蔽，引擎副本及原始 Grapher 安装目录只读，保留任务容器网络供模型认证使用。**Harbor 的外层任务容器不等于节点隔离**。请在任务镜像内安装 `/usr/bin/bwrap`（bubblewrap），并确保容器安全策略允许非特权 user/mount/PID namespace 和 bind/proc mount；适配器安装和 Grapher Graph preflight 会执行真实 bwrap 探测，失败即停止，不会强制 Serial 或使用 fixture 绕过边界。某些默认 Docker/云环境会禁用 user namespace，必须调整任务环境策略（不是把 Grapher 图节点改为无隔离）。

**验收状态：** 当前开发环境是 macOS，没有可运行的 Harbor Linux 任务容器；Linux 代码经交叉编译类型检查，Harbor 0.23.0 的 Python 3.12 实际包导入、安装/运行接口及指标映射已在 macOS 上模拟验证；但还需要在目标 Harbor 镜像运行 `cargo test --lib linux_sandbox`、真实模型 Graph→发布→verifier 端到端与路径/网络回归，才能报告可横向比较的完整分数。未通过隔离预检的 trial 属于环境不兼容，不是模型语义失败。Linux CI 在 `.github/workflows/linux-native.yml` 测真实 bwrap 隔离、并行原生 Pi 节点、源码/二进制同一 commit 和 Harbor adapter 取消后的进程清理；还需在实际 Harbor 容器复现该流程（外层 Docker/云环境的 namespace 策略可能不同）。

## 准备环境

在 **每个 task 环境内部**（不是 Harbor 所在机器）预装 Grapher 到 `/installed-agent/grapher`：包含可执行的 `backend/target/release/grapher`、本仓库的 `engine/`、`scripts/`、**锁定的** `pi/` 子模块及编译后的 `pi/node_modules/`。可用 `docker build -f benchmark/Dockerfile --build-arg GRAPHER_COMMIT=<固定 SHA> -t grapher-harbor:<SHA> benchmark` 创建无本地密钥/脏文件的基础镜像，再基于它构建所需任务镜像（不可抹去任务原有依赖）；如果与其他 harness 比分，任务镜像及可访问工具必须一致。非 root 任务用户还必须能读写安装目录所需的 Pi 配置，并使 Git checkout 可信。或者在 task 镜像构建阶段通过固定的 Grapher Git commit 和 `git submodule update --init --recursive` 获取代码，安装 Node.js 22.19+、稳定版 Rust、Git（需支持 `--path-format=absolute`）、C 编译工具链与 bubblewrap，再运行 `npm run pi:setup` 和 `node scripts/cargo.mjs build --release --manifest-path backend/Cargo.toml --bin grapher`。不要将本地 `.env`、令牌或不受控的全局 Pi 打包进去。`install()` 会校验 Linux bwrap、锁定 Pi、checkout 清洁状态及二进制内嵌 Git commit 与源码一致，并将该 commit 记录为 Harbor agent version；不在计时中的 trial 阶段下载/编译代码。可用 `--ak grapher_root=/absolute/path` 指定另一位置。

将 Harbor task 的 `environment.workdir` 设置成任务项目根目录（Grapher 直接编辑该目录；普通文件夹可由 Grapher 创建外置 shadow Git）。需允许访问模型服务商，按 Harbor 规范用 `--agent-env` 传认证。示例（在 Grapher 仓库根目录运行、Harbor 单独安装）：

```sh
PYTHONPATH="$PWD${PYTHONPATH:+:$PYTHONPATH}" harbor run \
  -p /path/to/harbor/tasks \
  -a benchmark.harbor_agent:GrapherAgent \
  -m anthropic/claude-sonnet-4-5 \
  --agent-env ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  --ak thinking=medium --ak max_parallel=4 --ak timeout_sec=3600
```

按模型替换 `-m` 和认证变量；模型名必须是锁定 Pi 内置的 `provider/model`。服务商自定义 endpoint 需经 Harbor `--agent-env` 显式传对应 base URL/认证；benchmark 模式禁止从宿主 `~/.pi/agent/models.json` 或安装目录 `.env` 偷偷继承自定义模型/端点（未经安装适配的全新 provider 不在支持范围）。Harbor 的 trial 超时需大于 `timeout_sec`（另留安装、启动和日志同步时间）。

## 可比性与终态

每个 trial 启动私有 loopback backend、数据目录和 Pi 配置目录，直接把 Harbor 原始 instruction 送给 `plan_goal`，**不传 mode**，让 Partitioner 选择 Serial/Graph；配置强制 `autoApprove=true`，编译通过后自动审批 Planner 图（旧后端仍待批时调用 `control approve`）。Partitioner、Planner、NodeAgent、Merger 的模型环境覆盖统一设为 Harbor `-m` 的值；不支持隐藏的 role model 改写。Serial/Graph 只有全部节点完成，Graph 还需成功发布到任务目录，才视为成功。失败、卡住、超时不伪装成成功。

Harbor 的评分仍由其原任务 verifier 决定；此适配器不写 verifier 文件，也不读取 expected answer。Agent 超时/取消会终止 backend 及其子进程；Linux runner 在被强制杀死时还设置 backend 的 parent-death signal，防止延迟写入干扰 verifier。后端日志、规划诊断与 `result.json`（route、模型、planning/run metrics 或失败原因）保存在 Harbor agent 日志目录，成功时会把 Grapher 的 Pi token usage 映射到 Harbor 的 AgentContext（输入包含缓存读写，缓存单独记账；不伪造费用）。对比其他 harness 请固定相同的数据集版本、任务镜像（含 namespace 权限）、模型**及服务商/endpoint**、密钥权限、预算、并发和重试策略；并记录 Graph 平台失败，不能只挑 Serial 样本报告成绩。
