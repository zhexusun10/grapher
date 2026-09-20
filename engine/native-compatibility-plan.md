# 原生路径映射调查与最终取舍

当前正式实现与完整交付说明见 **[native-execution.md](native-execution.md)**。Graph 的全局能力阻塞已解除，本文仅保留调查结论。

## 当前实现

所有 agent 为宿主原生 Pi instance。正式 `engine/workspace-tools.ts` 在工具执行前映射 read/write/edit/ls/find/grep 的项目路径；bash 通过 `engine/workspace-paths.mjs` 转换可识别的完整项目路径字面量，在节点真实 cwd 运行。模型侧普通节点路径呈现为项目根相对路径，项目外路径保持绝对形式，结构化 URI 保持有效的源项目绝对地址；已有脚本和程序内部动态路径不透明映射。项目外绝对脚本、统一项目路径的常见 bash 操作已通过实际原生 launcher 验证。

macOS Seatbelt 防止节点直接读写源项目、兄弟工作区和其他 session；共享 Pi 运行副本放在源项目外，避免自托管时阻断引擎。访问控制不等于透明重定向。脚本内部硬编码源项目路径仍可能被拒绝，这是当前明确接受的范围，不再因此阻塞整个 Graph。

Docker、VM、chroot、特权 helper 以及其他已否决方案均不作为实施方向。无需管理员密码。

## 保留的历史实验

`npm run probe:native-mapping` 在临时目录编译 Mach-O helper/dylib；结果位于 `native-mapping-evidence.json`。31 项正对照/反例复现：

- libc open hook 能让 A/B 用同一个路径读写不同文件。
- 直接系统调用、受保护系统程序、嵌套 shell 不遵守 hook，并能写入专门的临时 source marker。
- 叠加 Seatbelt 后误写被拒绝，但不会自动重定向。
- cwd、全局符号链接不提供 per-execution 透明映射。

报告 `contractSatisfied: false` 表示原先“任意程序绝对路径透明重定向”的完整契约未通过，不表示当前范围的 Graph 不可执行。

`npm run probe:file-mapping` 使用 Pi operations 的实验原型验证 read/write/edit 映射和子进程不继承该映射的边界。它不由生产 launcher 加载；正式适配已移到工具入口前，使 read 的预检查和 find/grep 的子进程同样拿到实际路径。

生产工作区/基线/fresh session 修复均保留。当前测试、身份绑定、自托管、绝对脚本、生命周期边界及源快照副作用，统一以 [完整实现说明](native-execution.md) 为准。
