# 宿主原生执行与统一项目路径

## 当前契约

所有角色使用锁定 Pi。Partitioner、Serial 和源目录 Merger 使用宿主 Node；Planner 和 Graph 节点保留各自独立 Git 工作区，macOS 使用 Seatbelt，Linux 使用 bubblewrap。Windows Planner/Graph 使用宿主进程与相同的独立 Git 工作区，不使用虚拟机或逐节点沙箱，访问权限与宿主用户相同；见 [Windows 原生执行](windows-native-plan.md)。macOS/Linux 的隔离预检失败仍拒绝 Graph，不降级。

Agent 新任务、节点交付和生成配置以项目根目录相对路径为约定，例如 `src/app.ts`、`reports/result.json`。项目外资料和脚本使用实际宿主绝对路径。Graph 的模型侧普通节点路径呈现为 `./...`，根目录为 `.`；后端保留物理目录用于诊断。file URL/URI 等结构化编码继续使用源项目绝对路径，避免生成无效 URI。旧项目绝对路径适配保留作为兼容层，不是新任务的首选路径。

这是显式工具适配，不是内核挂载命名空间。不能宣称任意程序都获得透明路径映射。

## 路径执行规则

- `read/write/edit/ls/find/grep`：将源项目路径前缀映射到当前节点工作区；相对路径从节点工作区解析；外部路径保持不变。
- `bash`：工具实现使用 Pi 的原生 Bash，Planner 直接注册 `createBashToolDefinition`；Windows 直接使用 Pi 选择的原版 Git Bash。Graph Node 保留既有的模型侧路径和退出码适配，不改 shell 语义。Graph Node 执行前的兼容层对源项目绝对路径做有限的字面量转换，覆盖常见路径参数、变量赋值、`--option=路径`、源目录绑定别名、转义空格、重定向、通配符、`$(...)` 命令替换，以及字面量 `sh/bash/zsh/dash -c` 子命令；嵌套命令的路径转换仍是有限模式适配。
- Bash 不隐式加入 `set -e` 或 `pipefail`；不修改调用者参数对象。
- 文件写入内容、edit 替换内容和已存在脚本不会被重写。模型侧读取内容中的当前物理路径会被规范为项目路径，因此它不是逐字节原始内容呈现；精确数据处理应在程序内进行。
- Planner 提示词及工作角色的运行时提示明确项目内相对、项目外绝对的路径约定。`cd` 后相对路径以 shell 实际 cwd 为准。`../` 不映射到源项目父目录；项目依赖 `../shared` 时仍需准备正确目录布局，不能靠提示或替换自动修复。
- 模型侧路径规范覆盖普通文本、JSON 转义、转义斜杠、shell 转义、file URL、URI 编码及对象键，并处理工具结果/错误/流式更新/命令元数据。边界匹配避免误改同前缀的其他目录。
- 图片、thinking 和 provider 签名等不透明内容保持原样。不能承诺任何编码、截图、字符拆分或未知扩展通道永不包含物理路径；当前不是通用信息防泄露系统。
- 源路径别名由文件工具和 bash 完整路径字面量适配共同支持。

| 操作 | 当前行为 |
| --- | --- |
| `read('/项目/config.json')` | 当前节点文件 |
| `cat /项目/config.json` | 完整路径字面量被转换，读取当前节点文件 |
| `p='/项目'; cat "$p/config.json"` | 完整路径赋值被转换 |
| `sh -c 'cat /项目/config.json'` | 支持字面量嵌套 shell |
| `pwd -P` | 实际命令返回物理 cwd，Graph 工具向模型呈现 `.` 或项目根相对路径 |
| 外部脚本使用 cwd/相对路径 | 在当前节点工作区操作 |
| 程序内部拼接源目录，或脚本文件硬编码源路径 | 不透明映射；macOS/Linux 阻止直接源访问，Windows 按宿主权限访问真实源目录 |
| 命令中的项目路径文本用于写入文件而不是文件操作 | 仍可能被 shell 字面量适配转换，属于文本映射固有限制；持久化配置优先相对路径 |

不要通过放宽源目录权限修补映射失败。工具适配负责常见路径，平台隔离负责保护越界访问，两者职责不同。

## 保留的运行机制

Planner 先落地，批准时对源目录当前文件生成基线，再分配节点工作区。父依赖快照由宿主 Git 组合；每次 execution 使用新的 session，不复制父节点/Planner 对话。Serial/Graph 路由独立持久化。Reject 不回撤文件。

普通 Git 基线会暂存并提交当前变更，包括用户已有的未提交修改，改变暂存状态。被忽略的未跟踪依赖不随快照传播。共享 HOME、临时文件及全局环境没有节点版本隔离。

自托管执行使用源目录之外的共享 Pi 引擎副本，由 `scripts/prepare-native-runtime.mjs` 准备并验证。Windows 沿用普通 TypeScript 入口和宿主 Node，引用锁定 Pi；不复制或补丁 Node/Git/MSYS，也不加载 AppContainer preload。共享副本包含 `pi-baseline.mjs` 及其 `cargo.mjs` 依赖。Windows 启动前将 Rust 扩展路径转换为 Node 可用的普通盘符/UNC 路径；Graph 路径适配支持 Windows 原生、斜杠、扩展路径和 Git Bash `/c/...`、`/tmp/...` 拼写。当前共享引擎副本仍无自动回收；修改适配器后需要重启 backend。

### Windows 清理与权限

失败的 AppContainer/MSYS、受限令牌和 Bind Filter 实验入口、Cargo features、preload、Node/MSYS 补丁和生成物已删除。Sandboxie 软件、服务、驱动及两个配置残留已清理。没有修改源目录/Git ACL、系统缓解策略或 Planner/Pi。

Windows 工作区与 session 是独立状态目录，但不是访问控制边界。任意子进程仍可按宿主权限访问源目录、兄弟工作区、其他 session、引擎和认证；外部脚本硬编码源路径也会操作真实源目录。只有可信项目适合此执行模式。

绑定目录缺失/不可访问时拒绝执行，不搜索迁移。当前绑定检查主要验证路径存在性，不提供完整目录身份检测。

## 尚未解决的边界

- 所有平台的 `bash` 工具都使用 Pi 原生 Bash；尚未实现的是任意子进程的透明目录重映射。执行前的绝对路径兼容转换不解析完整 shell 语法，无法映射程序运行时拼接或脚本内部硬编码的源项目路径。
- 取消、超时和服务关闭由平台进程树控制：macOS/Unix 使用 process group，Windows 使用 Job Object；这只解决生命周期，不提供文件系统隔离。
- 宿主服务、硬链接、共享认证等不是恶意多租户安全边界。Pi 使用专用配置目录，但模型工具仍可能读取正在使用的认证文件；当前没有通用凭据防泄露边界。Windows 后续方案必须保留已有认证和环境语义，不能静默删除环境变量中的 API key 或改变配置刷新行为。
- Windows Graph 按用户要求不提供逐节点文件访问边界；不能将独立 Git 仓库或 Job Object 描述为沙箱。Linux Graph 的隔离使用 bubblewrap；它必须在任务容器内成功创建 user/mount/PID namespace，遮蔽源目录、兄弟工作区和其他 session，允许当前节点/当前 session，且将引擎副本与原始 Grapher 安装目录设为只读（包括副本依赖符号链接的目标）；显式回挂容器的 `/dev`，预检 `/dev/null` 读写及原有源目录隔离。不支持 user namespace 的 Harbor 容器必须先调整环境。
- Windows 已实测原版 Bash 的数组、pipeline、subshell、background、嵌套 shell、Node/Git/Rust、退出语义、超时，以及生产 Planner/Graph 的并发、发布、取消和崩溃恢复。任意第三方工具链及未知扩展仍需单独验证；不承诺任意后台服务都能被 Job Object 接管。

## 验证

`npm run test:native` 使用实际 pinned Pi CLI 和各平台生产 launcher；macOS/Linux 检查文件边界，Windows 检查原生工具及路径映射，不期待权限拒绝。`npm run test:windows-native` 在原生 Windows 比较 Planner 与 Pi Bash，并通过生产后端和 pinned Pi 验证两个并发 Graph、父子快照、发布、取消、后台后代停止和崩溃恢复。仅模型响应来自本地确定性 HTTP 服务，不替换引擎、不使用 fixture 或外部付费 API。Windows CI 执行这两套验收。

`npm run test:extensions` 验证宿主工具语义与 Planner 图工具。`npm test` 验证工作区、基线、父子继承、路由和发布等回归。Linux 环境另外需运行 `cargo test --manifest-path backend/Cargo.toml --lib linux_sandbox` 与 Harbor 实际任务。通过这些测试不代表通用子进程透明映射或后台进程清理已解决。

关键文件：`engine/workspace-paths.mjs`（旧版路径适配的整合）、`engine/workspace-tools.ts`（文件工具）、`engine/prompt-extension.ts`（bash 与模型呈现）、`backend/src/native.rs`（启动及真实测试）、`backend/src/sandbox.rs`（macOS 访问控制）、`backend/src/linux_sandbox.rs`（Linux bwrap 启动与隔离预检）。
