# Bind Filter / Silo 历史调查（已停止）

当前 Windows Graph 按用户要求不使用逐节点沙箱，见 [Windows 原生执行](windows-native-plan.md)。本文件仅保存失败候选的研究结论，不提供当前实验入口。

调查确认 Windows 内置 `bindflt.sys`、`bindfltapi.dll`、`BfSetupFilter` export 和 Bind Filter 服务存在，空 Silo Job 创建成功。这不能证明满足 Grapher 的文件访问契约。

普通用户在人工临时目录中设置绑定返回 `0x80070005`；没有施加绑定或启动 Silo 测试子进程。[普通用户观测](windows-bindfilter-evidence.json) 保留该错误。

管理员实验的 UAC 请求被取消，helper 未运行，也没有管理员实测结果。[启动观测](windows-bindfilter-launch-evidence.json) 记录取消，而不是隔离成功。

实验脚本和 `build/windows-bindfilter/` fixture 已删除。没有新增第三方驱动、创建全局目录绑定或修改源目录/系统 ACL。Windows 当前只使用普通 Job 管理后代生命周期，不使用 Silo/Bind Filter。
