# Sandboxie 路线撤回与清理记录

此为历史记录，当前 Windows Graph 使用无逐节点沙箱的宿主进程，见 [Windows 原生执行](windows-native-plan.md)。

Sandboxie-Plus 1.18.5 配置依赖 `UseRuleSpecificity=y`；对应版本在缺少有效安全功能证书时会安排约五分钟后的进程终止，不满足所需功能免费长期运行的约束。因此已停止该路线，不购买证书或绕过授权检查。官方 [支持者证书说明](https://sandboxie-plus.com/supporter-certificate/) 说明了功能限制。

两次历史 DLL API 启动未到达测试脚本，不能证明 Bash、stdio、文件边界或 Graph 可用。[历史观测](windows-driver-evidence.json) 保留失败结果。

## 清理完成

- 官方卸载器已移除软件、服务和驱动；本次复查确认 `C:\Program Files\Sandboxie-Plus`、`SbieDrv`、`SbieSvc`、卸载注册项和实验进程不存在。
- 用户生成的 UI 配置及空的 `%LOCALAPPDATA%\Xanasoft\Sandboxie-Plus` 目录已删除。
- `C:\Windows\Sandboxie.ini` 普通用户删除返回权限错误；一次明确只删除该文件的 UAC 请求成功后，复查文件不存在。未修改系统 ACL。
- 项目实验脚本、helper、Cargo features、preload 和 Node/MSYS 补丁已删除；`build/windows-native-driver/`、`build/windows-bindfilter/` 与 `build/native/` 的安装包和实验生成物已清理。

实查状态见 [清理证据](windows-driver-removal.json)。未修改系统 Node/Git、源项目 ACL 或系统缓解策略。
