# Windows 原生 Graph 执行

## 当前方案

按用户更新后的要求，Windows 使用**宿主原生进程 + 独立 Git 工作区**，不使用虚拟机、逐个 Node agent 的沙箱、第三方隔离驱动或付费/试用功能。原版 Node、Git for Windows Bash 和锁定 Pi 均不打补丁。

`native::execution_command` 在 Windows 的私有工作区直接启动共享 Pi 运行副本；`process_control` 继续在子进程挂起期间分配 kill-on-close Job，然后恢复执行。Job 只管理进程生命周期，不限制文件访问。

图编译、审批、调度、并发、反馈、基线、独立 Git 仓库、父依赖快照、fresh session、合并、发布与恢复逻辑未因 Windows 启动方式而改变。Planner 仍直接注册项目内 Pi 的 `createBashToolDefinition`；不替换为 PowerShell、不新增 Planner Bash 包装、不修改 Pi 子模块。

### 与 macOS 的区别（必须知悉）

Windows 对齐 Graph **工作流程**，不对齐 Seatbelt 的文件访问边界：

- 当前工作区、源目录、兄弟工作区、其他 session、引擎、HOME、外部资源均沿用宿主用户权限。
- 独立 Git 仓库隔离快照和传播状态，**不是文件系统沙箱**。
- 保留既有 Graph 工具路径适配；脚本内部硬编码源目录、动态拼接路径或未识别的工具通道可以直接访问真实源目录。
- 认证和环境保持既有 Pi 语义；没有凭据隔离或恶意多租户保证。
- 仅对可信项目、扩展和工具链使用此模式。macOS/Linux 的既有文件边界和失败拒绝策略保留。

## 兼容层

- Windows 启动 Node 的入口路径去除 Rust `canonicalize()` 产生的 `\\?\` 前缀；UNC 路径保持 UNC 语义。
- Graph 路径适配识别 Windows drive、正斜杠、扩展路径、Git Bash `/c/...` 和 `cygpath` 返回的挂载路径（例如 `/tmp/...`）。转换不依赖访问源目录。
- 共享 runtime 复制并校验锁定 Pi，包含 `pi-baseline.mjs` 的 `cargo.mjs` 依赖。可通过 `GRAPHER_NATIVE_RUNTIME_PARENT` 指定运行副本父目录；修改适配器后重启后端。
- Windows managed `rg/fd` 复制不覆盖已存在的本地工具，无需 symlink 管理员权限。
- Bash 中优先使用相对路径；传给 Windows 原生程序的路径通常使用 `C:/...`。原版 Git Bash 的 Windows argv 转义限制不由 Grapher 改写 shell 语义来规避。

## 实机验证

```powershell
npm.cmd run test:windows-native
npm.cmd run test:native
npm.cmd run test:extensions
npm.cmd run test:bindings
npm.cmd run test:pi
npm.cmd test
npm.cmd run check
npm.cmd run build
```

`test:windows-native` 使用生产 Rust 后端、真实 pinned Pi、Planner extension、Git 和原版 Bash；**只有模型响应**由临时本地 OpenAI-compatible HTTP 服务提供，不调用外部模型、不读取用户认证、不使用 fixture 引擎。

已通过：

- Planner 与 Pi 内置 Bash 的实现一致；数组、管道、命令替换、subshell、后台子进程、嵌套 Bash/sh、重定向、stdout/stderr、Windows Node/Git/Rust、非零退出码与超时。
- 中文/空格路径下两个并发 Planner/Graph，各有并行分支及合流节点。
- 实际图工具编译、审批前 Planner 文件落地、父子 Git 状态传递、独立 sessions、完成节点提交发布到源仓库。
- 取消停止 Bash 后台 Windows Node writer；后端被强制终止时 Job 的后代停止写入，重启后中断 execution 标为 failed、Run 暂停。
- `test:native` 的生产 launcher 并发文件工具、绝对路径映射、外部脚本、嵌套进程、超时和取消。
- fixture 回归继续覆盖反馈、冲突、发布重试、普通文件夹、暂停、恢复和会话分支。外部商业模型与任意第三方工具仍需各自验证。

不依赖有试用终止机制的组件；未将短时测试声称为十分钟连续模型调用的证据。

## 错误方案清理

- Sandboxie 已卸载；服务、驱动、安装目录和卸载注册项均不存在。`C:\Windows\Sandboxie.ini` 及 `%LOCALAPPDATA%\Xanasoft\Sandboxie-Plus\Sandboxie-Plus.ini` 均已删除；系统配置删除通过一次明确限定路径的 UAC 请求完成。
- 已停止两个遗留的 AppContainer/preload 实验进程；通过 Windows `DeleteAppContainerProfile` 删除 14 个 Grapher 实验 profile，复查剩余为零。闲置的历史运行副本也已删除，不清理正常工作区或会话。
- 已删除 AppContainer/受限令牌 helper、对应 Cargo features 与 Windows API 依赖、preload、Node/MSYS 二进制补丁、Bind Filter 实验脚本、遗留的 probe/driver-launch 可执行文件及 `build/` 下的实验安装包和生成物。
- [受限令牌结果](windows-native-findings.md)、[Sandboxie 撤回记录](windows-driver-review.md) 和 [Bind Filter 记录](windows-bindfilter-review.md) 仅为历史审查证据，不是当前运行依赖。
