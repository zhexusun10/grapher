# 原生 Windows 支持实施路线

## 结论摘要

Grapher 当前不能在 Windows 原生构建或运行。阻塞不只是 `scripts/dev.mjs` 的 POSIX 假设：Rust 后端在多个模块直接使用 Unix-only API；生产 Graph 执行强制要求 macOS Seatbelt；Pi launcher、路径转换和生命周期管理也都按 POSIX 行为设计。

建议按“平台编译与 Serial 首先可用、Graph 安全边界单独过门槛”的路线实施。Windows 原生启动可以先覆盖 UI、配置、规划和 Serial；Graph 并发、shadow repo、合并和发布只有在 Windows 上建立并通过验证的隔离机制后才算支持。Job Object 解决进程生命周期，不提供文件系统隔离，不能用它替代 Seatbelt。

## 当前实现状态

阶段 0/1/2/3 的代码已落地：Windows 10/11 x64 可使用 MSVC Rust toolchain、Git for Windows、Node.js 和普通用户权限运行 backend/frontend；规划、审批、Serial、Graph 并发、worktree、合并、发布、取消和运行时锁均保留。Windows 进程执行使用 Job Object，并在 Job 接管后恢复挂起的子进程；Unix 继续使用原有 process group 和 `flock` 行为。

Windows Graph 使用 Windows AppContainer 作为文件系统访问边界。每个 Graph Execution Instance 使用独立容器 SID，只向当前 worktree、session/runtime 数据、引擎副本、agent 配置和必要工具目录授予访问权限，并授予网络 capability；源仓库、兄弟 worktree、其他 session 和共享 Git object 数据库不在授权集合中。路径工具适配仍只是易用性层，不能替代该 OS 访问控制。

已加入 `.github/workflows/windows-native.yml`，用于 Windows MSVC 下的前端检查、构建、backend `cargo check` 和 library tests，并执行 native/binding 回归。完整 Windows 交付仍需在真实 Windows 主机上验证 AppContainer 对源目录、兄弟节点、session、Git metadata、junction/symlink/reparse point、子进程、Provider/Auth 和一次完整 Graph 发布流程的拒绝/允许边界。

## 仓库现状与主要阻塞

| 区域 | 现状 | 影响 |
| --- | --- | --- |
| Rust 构建 | `backend/src/engine.rs`、`provider_auth.rs`、`runtime.rs` 无条件导入 `std::os::unix`；还调用 `process_group`、`libc::kill`、`flock` | Windows target 无法编译 |
| Graph 执行 | macOS 使用 `/usr/bin/sandbox-exec`；Windows 使用 AppContainer helper、每实例 SID 和 ACL；非 Serial 在审批和启动时要求对应 capability | capability 或授权失败时拒绝当前 Graph，不降级为无隔离执行 |
| 文件系统语义 | Git worktree、shadow repo、清理、符号链接和路径映射跨平台覆盖不足 | 合并、隔离、删除和路径边界可能与 macOS 不同 |
| 生命周期 | engine 与 Provider/Auth bridge 通过负 PID 杀 Unix 进程组；server 监听 Unix 信号 | 取消/超时可能遗留 Pi、Node 和工具后代进程 |
| 主机交互 | `workspace::pick_repository` 仅 macOS 启用；文件夹选择器用 AppleScript | Windows UI 无法选择仓库 |
| 开发启动 | `scripts/dev.mjs` 使用 `lsof`、冒号 PATH、负 PID 和 `detached` | `npm run dev` 的清理/停止逻辑不可移植 |
| Shell | Pi 源码已有 PowerShell 工具实现；Grapher 集成注册定制工具并适配 Bash 命令 | 需验证 launcher 的工具选择和系统提示，不应先假设 Git Bash 是唯一方案 |

关键实现位置：`backend/src/{engine,provider_auth,runtime,native,sandbox,workspace,server}.rs`、`engine/{workspace-paths.mjs,workspace-tools.ts}`、`scripts/{dev.mjs,cargo.mjs,prepare-native-runtime.mjs}`。

## 目标架构

### 1. 平台能力边界

将 OS 专属行为限制在小型模块，并通过编译期选择提供实现：

- `process_control`：Unix process group 与 Windows Job Object，共用 spawn、超时、取消、wait 接口。
- `runtime_lock`：提供跨进程独占锁，并在 `Runtime` drop 时释放。
- `shutdown`：主线程接收 Ctrl-C/关闭事件并触发有序停机；信号回调不做阻塞清理。
- `sandbox`：明确区分 `Seatbelt`、Windows AppContainer 实现及“不支持”。任何平台 capability 探测或授权失败都必须关闭该次 Graph 启动，而不是静默降级为无隔离执行。
- 文件夹选择：平台原生对话框，或由前端选择目录后交由后端校验；不通过拼接 PowerShell 脚本文本处理任意路径。

不建议在业务代码散布 `cfg(windows)`，也不建议将平台 API 简化成只负责启动 `Command` 的 trait：取消、子孙进程、资源释放和 sandbox capability 都是生命周期契约的一部分。

### 2. Windows 进程树控制

使用 Windows Job Object，并启用 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。超时/取消时调用 `TerminateJobObject`，正常退出时 wait 并关闭句柄。需要覆盖 engine 执行进程和 Provider/Auth bridge，统一处理 Grapher -> Node -> Pi -> shell/工具的后代树。

实现须处理 Job 分配竞态：子进程不能在加入 Job 前先生成逃逸后代。优先使用挂起创建、AssignProcessToJobObject 后 ResumeThread 的受控 spawn，评估宿主进程已处于 Job、嵌套 Job 和 `CREATE_BREAKAWAY_FROM_JOB` 的行为。若托管环境不允许分配，返回明确错误，不能退回仅 kill 父进程。

验证用例应启动多层子进程，在取消、超时、父进程 panic/退出后检查所有后代均已退出，并确认不再写文件。Job Object 不限制其访问源仓库或网络。

### 3. Graph 文件系统隔离：独立安全门槛

现有 Seatbelt 是内核文件访问边界；`engine/workspace-tools.ts` 和 `workspace-paths.mjs` 是显式工具适配，不是安全沙箱。源仓库快照校验只能检测部分结果，无法阻止运行中越权访问。因此不能把“worktree + 工具拦截 + 前后 hash + Job 限制”描述成与 Seatbelt 等价。

建议做一个 Windows sandbox 技术验证，候选为低权限 token / AppContainer 等 Windows 原生访问控制能力，重点确认：

- 节点只可读写自己的 worktree 和当次 session 所需数据；拒绝源仓库、兄弟 worktree、其他 session 与共享 Git object 数据库。
- Git、Node、Pi、编译器、provider 网络访问和认证路径在最小权限下能工作。
- 默认用户权限可启动，不需管理员权限；子进程继承限制，不能通过另起进程逃逸。
- UNC、junction、symlink、硬链接、reparse point 不能绕过路径边界。

若候选方案不能满足这些条件，发布范围应限制为 Windows Serial；Graph 保持禁用并给出原因。只有产品明确接受较弱的本机用户级隔离威胁模型后，才考虑把无强制隔离的 Graph 作为 opt-in 实验功能，且必须在 UI/文档中准确披露。不可用普通用户态路径检查冒充安全保证。

### 4. 锁、信号与系统调用

- 运行时锁采用有 Windows 实现且支持进程退出自动释放的锁库，封装在 `runtime_lock`。验证非阻塞竞争、drop 释放、异常退出释放及 Windows 文件共享模式；选择依赖前先核对其 Windows 后端和 API 语义，避免机械替换为 API 不匹配的锁类型。
- `signal-hook`/Ctrl-C 仅用于发出 shutdown 请求。由 server 主循环执行关闭 HTTP 服务、停止任务并等待 worker 的流程；不要在 handler 内 `exit(0)`。
- 将 `backend/src/engine.rs` 的 `/bin/date` 替换为 Rust 时间 API 或现有跨平台时间依赖；审计 `/dev/null`、文件名大小写、打开/删除语义及 Unix 专属导入。

### 5. 路径、Git 和 shell

- 路径内部继续使用 `Path`/`PathBuf`；命令边界只在确有 POSIX 工具契约时转成 POSIX 路径。不要全局把反斜杠替换为斜杠、删除 `\\?\` 前缀或将路径字符串小写化。扩展长度路径与 UNC 应保留并测试。
- 路径包含检查基于 canonical path 与平台路径组件语义，兼顾 Windows 大小写不敏感卷、大小写敏感目录和不同盘符；避免 Unicode 小写转换模拟 Windows 比较规则。
- Git for Windows 是 Git 依赖，并非自动等同于运行 Agent shell 的要求。优先验证 Pi 自带 PowerShell 工具及 Grapher launcher；若项目执行契约依赖 Bash，再将 Git Bash 明确列为可选/必需前置条件，并逐项验证 `bash.exe` 参数、环境变量和 MSYS 路径转换。不要盲目设置 `MSYS_NO_PATHCONV=1`，它可能破坏 Windows 路径参数。
- 在 Windows CI 覆盖 worktree 创建/删除、合并冲突、shadow repo、发布、含空格/非 ASCII 路径、盘符路径、UNC、忽略文件和 symlink 权限差异。symlink-or-copy 不是通用替代：目录复制会破坏依赖语义并增加体积，应仅在明确允许的资源上采用。
- Graph 的路径工具适配继续作为易用性层；它不能承担跨进程访问控制。

### 6. 开发与 UI 启动

`npm run dev` 使用 Node 跨平台实现：PATH 用 `path.delimiter` 和 `path.join`；端口检测使用平台工具，但发现已占用端口时只报告 PID 并退出，绝不尝试终止非本次启动的进程；child 生命周期使用明确的 Windows tree termination 实现，避免 Unix `detached`/负 PID 假设。停止行为须等待子进程退出并有超时错误。

Cargo wrapper 继续优先尊重 `CARGO` 和 PATH，并正确转发 Windows Ctrl-C/退出码。文件夹选择可先由前端原生目录输入/选择能力交互，后端仍须校验路径与 Git 状态。

## 实施顺序与验收门槛

### 阶段 0：Windows CI 基线与阻塞盘点

建立 `windows-latest` 工作流，先运行 `cargo check` 记录全部编译错误；增加 Node 脚本静态/单元测试。确认锁定 Pi 依赖、npm install、Cargo MSVC toolchain 和 Git for Windows 的实际要求。此阶段不宣称已支持。

**通过条件**：可重复安装依赖；CI 输出按模块归类的错误清单；macOS 现有测试保持通过。

### 阶段 1：平台编译与 Serial 工作流

拆出平台模块，处理锁、shutdown、系统日期、folder picker、路径和 `dev.mjs`。Windows 支持仓库选择/绑定、规划、批准、Serial 和 Graph 执行、取消。Graph capability 未就绪时仅拒绝当前执行请求，不改变其他功能。

**通过条件**：Windows `cargo check`、Rust tests、`npm run check/build` 和 dev 启停通过；Serial 可实际调用 provider 与 Pi，完成一次仓库内文件修改；应用退出无后代进程残留；macOS 回归通过。

### 阶段 2：Job Object 与工具链生命周期

落地并测试 backend 与 Node/Pi/shell 全链进程管理，覆盖取消、超时、关闭、启动失败、并发会话。记录 Windows 托管环境和嵌套 Job 限制。

**通过条件**：进程树测试在 Windows CI 重复通过；不存在只 kill 根 PID 的执行路径；锁竞争测试和 server shutdown 测试通过。

### 阶段 3：Graph sandbox 技术验证

以 Windows AppContainer 为平台 sandbox provider，完成攻击性测试覆盖源目录、兄弟节点、session、Git metadata、junction/symlink/reparse point、hard link、子进程和临时退出。授权失败时停止当前 Graph 实施并返回明确错误，不退回无隔离执行。

**通过条件**：在普通权限账户下，测试证明越界读写被 OS 拒绝，同时允许目标 Git/Node/provider 工作流；无静默降级；独立审查 sandbox threat model。

### 阶段 4：Graph 端到端与发布支持

实现平台 sandbox provider 后再接入 Graph 调度、并发、工作区组合、冲突恢复与 publication。增加 Windows CI 端到端 fixture，并在真实 Windows 主机做一次手工发布流程。

**通过条件**：双节点并行与下游执行、冲突/人工恢复、取消清理、重启恢复和最终发布全部通过；源项目及兄弟工作区越权探测失败；文档清楚说明残余风险。

### 阶段 5：发行与用户文档（可选）

当前仓库以 Vite + Rust HTTP backend 开发启动为主，不存在已配置的桌面安装包链路。先确定交付形态，再决定 MSIX/签名安装程序、自动更新、数据目录、日志和卸载策略；不要把安装包工作混入首个原生支持里程碑。

## 初期开发环境

- Windows 10/11 x64。
- 与仓库锁定依赖兼容的 Node.js 版本（以 `package-lock.json`/CI 验证为准）。
- Rust stable MSVC target 与 Visual Studio Build Tools C++ workload。
- Git for Windows；是否要求 Git Bash 由阶段 1 的 Pi launcher 验证决定。

预期开发入口仍为 `npm ci`、`npm run pi:setup`、`npm run dev`，但在 Windows CI 通过前不应作为可用用户指南发布。`npm ci --ignore-scripts` 不应默认推荐，除非验证 Pi/native 依赖确实需要跳过安装脚本。

## 不在首期范围

- Windows ARM64、Linux 原生支持。
- 安装器、代码签名、自动更新。
- 任意程序的透明文件系统路径重映射。
- 管理员权限、WSL、Docker 或 VM 作为运行前置条件。
- 未经安全门槛审查的 Windows Graph 隔离能力。

## 关键实现文件

- 进程与 backend 生命周期：`backend/src/engine.rs`、`backend/src/provider_auth.rs`、`backend/src/server.rs`
- 安全与执行启动：`backend/src/native.rs`、`backend/src/sandbox.rs`、`backend/src/windows_sandbox.rs`
- 锁与平台交互：`backend/src/runtime.rs`、`backend/src/workspace.rs`
- Pi 工具集成：`engine/entrypoint.mjs`、`engine/prompt-extension.ts`、`engine/workspace-tools.ts`、`engine/workspace-paths.mjs`
- 开发脚本：`scripts/dev.mjs`、`scripts/cargo.mjs`、`scripts/prepare-native-runtime.mjs`

## 参考

- Microsoft Job Objects：https://learn.microsoft.com/windows/win32/procthread/job-objects
- Windows AppContainer：https://learn.microsoft.com/windows/win32/secauthz/appcontainer-isolation
- Node.js child process：https://nodejs.org/api/child_process.html
- Rust `std::os::windows` 文档：https://doc.rust-lang.org/std/os/windows/
