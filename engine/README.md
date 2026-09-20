# Execution Instance Engine: Pi baseline

Pi 是 Grapher 唯一的生产 Execution Instance Engine。一次模型执行称为 **Execution Instance**；Graph 节点执行实例称为 **Node Agent**，最终发布冲突使用专用 **merger** 实例。

## 所有权边界

- `pi/`：未修改的 upstream Pi submodule，拥有 execution core、provider/API、认证、CLI、SDK、skills 和 extensions。
- `engine/entrypoint.mjs`：校验锁定基线，并通过仓库内 tsx 启动 upstream CLI；不回退到全局 Pi。
- `engine/pi-lock.json`：锁定 upstream commit、package lock 和模型目录校验和。
- `engine/model-data/`：由 upstream hydration 流程产生的模型目录构建输入，不是 Grapher 自行维护的 provider 实现。
- `engine/provider-host.ts`：在独立进程中调用 upstream `ModelRuntime`。
- `backend/src/engine.rs`：拥有进程组、角色配置、超时、取消、JSON 事件消费和 Execution Instance 生命周期。
- `backend/src/provider_auth.rs`：Provider/Auth Adapter 的本地 IPC 桥接。

Grapher 拥有图编译、调度、工作区、sandbox、发布和事件记录；Pi 拥有模型调用及 provider/auth 能力。Rust 后端和浏览器不读取或保存 Pi 的 token/key。

当前锁定版本见 [pi-lock.json](pi-lock.json)。更新版本必须显式审阅并同步 gitlink、lock manifest 和模型数据校验和，运行时不会浮动更新。

## 安装与验证

```sh
git submodule update --init --recursive
npm run pi:setup
npm run pi:verify
npm run pi -- --version
npm run pi
npm run pi:build
```

要求 Node.js 22.19+、Git 和 npm。`pi:setup` 校验 commit/lock/checksum，安装 upstream 依赖并恢复固定模型目录；`pi:build` 执行 upstream offline build。

开发入口直接使用锁定源码和仓库内 tsx，不要求系统安装 Pi。认证可在 Grapher 设置界面完成，也可通过 `npm run pi` 使用 upstream `/login`、`/logout`。

## 角色策略

| 角色 | Pi 加载策略 |
| --- | --- |
| Partitioner | 无工具、无 context files、无 skills/extensions，模型跟随全局配置（或由 `PARTITIONER_MODEL` 覆盖），思维链永远关闭（`thinking=off`，若不支持则设为最低） |
| Planner | 只开放 `node,edge,read,bash`，加载 Grapher 显式 planning extension，不加载项目 context/自动扩展 |
| Node Agent | 开放 Pi 原生工具，允许受信工作区的 skills/extensions |
| Merger | 固定冲突修复 prompt 和工具，不加载项目 context/自动扩展 |

生产入口始终为 `engine/entrypoint.mjs`。历史配置中的 command/args 只在 `fixture` 测试构建可注入，不能选择另一生产引擎。

后端会清除继承的 `PI_MODEL`、`PI_THINKING`、`PI_PROVIDER`、`PI_REASONING_LEVEL`、`PI_SESSION_ID` 和 `PI_SESSION_FILE`，再按角色显式传入模型、thinking、session 和 `GRAPHER_MODE`。

## Provider/Auth Adapter

Adapter 支持 upstream provider catalog、login、poll、交互响应、cancel 和 logout。长期凭据及刷新逻辑留在 upstream `ModelRuntime`；浏览器只接收非敏感状态并提交当前认证交互所需输入。

修改 provider/auth 边界时，应同时验证：

```sh
npm run test:pi
npm run check
cargo check --manifest-path backend/Cargo.toml --no-default-features
npm run test:http
```

## 同步 upstream

1. 运行 `npm run pi:verify`，确认当前 submodule 与锁文件一致；保留父仓库已有修改。
2. 在 `pi/` 中 fetch 目标 upstream，记录并审阅完整 commit SHA。
3. 仅使用显式目标 SHA 更新 submodule；不要使用启动时 `git pull` 或 `submodule update --remote`。
4. 使用新 upstream 的 lockfile 安装依赖并运行模型数据 hydration。
5. 更新 `engine/pi-lock.json`、`engine/model-data/` 和父仓库 gitlink。
6. 运行 setup、verify、offline build、CLI smoke、后端测试、HTTP/UI 测试和 sandbox 测试。
7. 若使用 fork commit，必须先推送到可公开获取的 remote，再更新 `.gitmodules` 并用全新 clone 验证。

基线更新、适配层修改和校验数据应在同一变更中提交。任何构建或合约测试失败都不能标记为可发布。
