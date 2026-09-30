# Windows 受限令牌历史实验结果（方案已撤销）

> 当前 Windows Graph 使用用户要求的无逐节点沙箱宿主进程，见 [Windows 原生执行](windows-native-plan.md)。下文只保留切换方案前的失败证据。受限令牌 helper、npm 实验入口、Bind Filter 脚本与安装生成物均已删除，不再继续这些实验。

实验当时 Windows Graph 尚未实现。按 [原生执行计划](windows-native-plan.md) 完成受限令牌可行性实验后，7 种组合均未满足既有文件访问契约。生产启动器继续拒绝私有 execution，未接入无隔离降级。

## 历史实验入口与变更范围（入口已删除）

在具有已安装依赖、锁定 Pi、Rust 和原版 Git for Windows 的普通 Windows 用户环境执行：

```powershell
npm.cmd run probe:windows-native
```

历史命令离线构建独立 `windows-native-experiments` feature 下的 `windows-native-probe` binary，调用未修改的 Pi Bash 与实际 Planner extension，再生成 [完整 JSON 证据](windows-native-evidence.json)。可以用 `npm.cmd run probe:windows-native -- --output build/windows-native-evidence.json` 改变报告路径。

仅 Grapher 新建临时文件的 ACL 得到独立 SID 授权；源目录、源 Git、安装目录、Node、Git/MSYS、Rust、系统 DLL 的 ACL 与二进制均不修改。实验临时目录在完成或失败后清理。未改变 Planner/Pi、图编译、调度、基线、工作区、父依赖快照、session、合并、发布或已有路径适配逻辑。

运行在 Codex 沙箱时，Node 的 `uv_os_get_passwd` 失败，不能代表普通宿主运行条件。本机报告来自获得授权后的宿主用户环境；调用者是否提权、是否已带限制 SID 均记录在报告中。对已带限制 SID 的调用者，`CreateRestrictedToken` 还可能与原有限制取交集，不能直接用于推断普通用户行为。

## 原版 Bash 基线

Pi 内置 `createBashToolDefinition` 与实际加载的 `backend/resources/planner.ts` 各通过 13 项检查，共 26 项：数组、管道、命令替换、subshell、后台子进程、嵌套 Bash/sh、重定向、原生退出语义、stdout/stderr、Bash 启动 Windows Node、Git、Rust，以及非零退出码。检查在中文和空格工作目录中执行，命令参数保持原样。

这是**未使用受限令牌的宿主基线**，只证明当前 Node/Pi/Planner/原版 Git Bash 的原生兼容性。没有证明受限令牌下的启动、MSYS fork、独立 desktop、命名对象权限、后代继承、完整图运行或取消恢复。

## 访问矩阵

Rust helper 从调用者主令牌派生候选令牌，禁用大部分特权，然后在当前线程 impersonation 下通过真正的 `CreateFileW(OPEN_EXISTING)` 检查读取、写入、执行和 `WRITE_DAC`。不调用文件写入或截断。工作区、私有 Git、session 和引擎是授权给独立 SID 的新建文件；其他文件保留默认 ACL。工具链和 DLL 是实际安装文件，只尝试打开，不改动。

本机实测如下。`读写` 表示两项打开均成功；`只读` 表示读成功、写失败；`拒绝` 表示读写均失败。引擎的 `WRITE_DAC` 也必须被拒绝。

| restricting SIDs / flags | 当前工作区、Git、session | 源、兄弟、其他 session | 引擎 | 外部资源 | 原版 Node/Bash/MSYS/系统 DLL | 用户 Rust | 契约 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 仅禁用特权 | 读写 | 读写 | 读写 | 读写 | 只读、可执行 | 读写、可执行 | 失败 |
| 调用者 SID | 读写 | 读写 | 读写 | 读写 | 拒绝 | 读写、可执行 | 失败 |
| execution SID | 读写 | 拒绝 | 只读 | 拒绝 | 拒绝 | 拒绝 | 失败 |
| execution SID + WRITE_RESTRICTED | 读写 | 只读 | 只读 | 只读 | 只读、可执行 | 只读、可执行 | 失败 |
| execution SID + BUILTIN Users | 读写 | 拒绝 | 只读 | 拒绝 | 只读、可执行 | 拒绝 | 失败 |
| execution SID + Everyone | 读写 | 拒绝 | 只读 | 拒绝 | 拒绝 | 拒绝 | 失败 |
| execution SID + 调用者 SID | 读写 | 读写 | 读写 | 读写 | 拒绝 | 读写、可执行 | 失败 |

基线确认所有待测文件可读取，所有自建文件可写入，排除原先已无权限的假阴性。报告保留每项成功/失败及 Windows 错误码。源、兄弟、其他 session、外部资源的 DACL 在实验前后逐字节相同。

关键反例是源文件和外部资源拥有相同 DACL，两者对所有候选令牌的读写结果相同。当前契约要求阻断源文件，同时保留外部资源使用方式。微软说明，限制 SID 触发第二次 DACL 检查；检查使用 SID/ACL，不提供路径排除规则。[Restricted Tokens](https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens)、[CreateRestrictedToken](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken)。

因此，**只在 Grapher 自有工作区/session/引擎上增加允许 ACE，无法为未改动且 ACL 相同的源文件和外部文件产生不同权限**。这是由文档与实测反例得到的推断，不能通过加入 Job Object 修复。给用户外部目录/工具链广泛增加 ACE、修改源目录 ACL 或收紧外部资源语义都超出计划约束。只限制写入也不能满足源目录读隔离和外部资源写入契约。

本实验检查已有文件，没有检查目录创建、junction/symlink/hardlink、Git alternates、跨进程句柄、多个 execution 或生命周期。阶段 1 已失败，因此没有继续实现该组合的 `CreateProcessAsUserW` launcher，更没有接入生产。仅免除 `SE_ASSIGNPRIMARYTOKEN_NAME` 不能证明整个 launcher 无需其他权限；进程创建与 DLL 初始化仍需要后续候选独立验证。[CreateProcessAsUserW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw)。

## 后续宿主原生候选及部署成本

需要一个能按进程/路径过滤访问的机制，而不能只重复同一 ACL 检查。以下是候选评估，不是可用性声明；均不依赖虚拟机。

| 候选 | 能力与部署成本 | 需要证明的条件 |
| --- | --- | --- |
| Windows 文件系统 minifilter | 可在宿主内核 I/O 层过滤操作；需要 WDK、驱动与服务安装、签名和提权部署，维护成本高 | per-execution 进程归属、路径/对象别名、Git 对象例外、并发、崩溃恢复，以及未修改 Git Bash/Windows 工具链兼容性 |
| Sandboxie-Plus（本次路线已排除） | 本次配置需要证书功能 `UseRuleSpecificity`；无有效证书会在约 5 分钟后终止进程，不满足免费长期运行要求；已卸载本次新装的软件 | 历史启动实验未到达测试脚本，不能证明 Bash、stdio 或隔离可用；参见 [撤回记录](windows-driver-review.md) |
| Windows 自带 Bind Filter / Silo（评估已停止） | 本机已有系统组件，空 Silo Job 创建成功；普通用户设置绑定返回 `0x80070005`；没有新增第三方安装 | 须先实测 Job 作用域、路径别名/文件身份、普通用户目标进程和生命周期，再做 Bash/Graph 验收；参见 [候选实查](windows-bindfilter-review.md) |

微软的 [Filter Manager 模型](https://learn.microsoft.com/en-us/windows-hardware/drivers/ifs/advantages-of-the-filter-manager-model) 提供 I/O 回调与用户/内核通信设施；[minifilter 安装说明](https://learn.microsoft.com/en-us/windows-hardware/drivers/ifs/creating-an-inf-file-for-a-minifilter-driver) 和 [驱动签名要求](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/kernel-mode-code-signing-policy--windows-vista-and-later-) 明确驱动部署及签名成本。此候选不能通过关闭系统签名或缓解策略绕过这些要求。

Sandboxie 的 [ClosedFilePath](https://sandboxie-plus.github.io/sandboxie-docs/Content/ClosedFilePath/)、[OpenFilePath](https://sandboxie-plus.github.io/sandboxie-docs/Content/OpenFilePath/)、[ReadFilePath](https://sandboxie-plus.github.io/sandboxie-docs/Content/ReadFilePath/) 与 [Rule Specificity](https://sandboxie-plus.github.io/sandboxie-docs/PlusContent/RuleSpecificity/) 是历史研究依据。本次配置需要的证书功能不符合新增的免费约束，已停止该路线；不会用短时启动作为生产可用证据。

用户已允许评估原生驱动依赖，但要求安装前单独确认，且所需功能必须免费长期运行。自建 minifilter 也不能直接称为零成本方案：微软 [硬件开发者计划注册要求](https://learn.microsoft.com/en-us/windows-hardware/drivers/dashboard/hardware-program-register) 要求 EV 证书，没有证书的组织需购买。这些历史沙箱候选未满足当时的约束。用户后来明确要求不使用逐节点沙箱；当前采用宿主原生执行，而不是继续或启用这些失败候选。
