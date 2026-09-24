# Execution Instance Engine: Pi baseline

Pi 是 Grapher 唯一的生产 Execution Instance Engine。一次模型执行称为 **Execution Instance**；Graph 节点执行实例称为 **Node Agent**，最终发布冲突使用专用 **merger** 实例。

## 所有权边界

- `pi/`：未修改的 upstream Pi submodule，拥有 execution core、provider/API、认证、CLI、SDK、skills 和 extensions。
- `engine/pi-compat.ts`：生产侧 Pi SDK、私有路径解析与 CLI 入口的集中适配边界；升级时优先审阅此处，并检查进程启动和认证适配。
- `engine/entrypoint.mjs`：校验锁定基线，并通过仓库内 tsx 启动 upstream CLI；不回退到全局 Pi。
- `engine/pi-lock.json`：锁定 upstream commit、package lock 和模型目录校验和。
- `engine/model-data/`：由 upstream hydration 流程产生的模型目录和 `.manifest.json` 校验清单，供全新 clone 离线构建；不是 Grapher 自行维护的 provider 实现。
- `engine/provider-host.ts`：在独立进程中调用 upstream `ModelRuntime`。
- `backend/src/engine.rs`：拥有进程组、角色配置、取消、JSON 事件消费和 Execution Instance 生命周期。
- `backend/src/native.rs`：宿主启动策略、Graph 映射能力门槛、专用认证目录和旧 lease 检查。
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

要求 Node.js 22.19+、Git 和 npm。`pi:setup` 校验 commit/lock/checksum，安装 upstream 依赖、恢复固定模型目录并执行 offline build（新版本的源码入口需要 sibling workspace 的 `dist/`）；`pi:build` 可单独重建。

开发入口直接使用锁定源码和仓库内 tsx，不要求系统安装 Pi。认证可在 Grapher 设置界面完成，也可通过 `npm run pi` 使用 upstream `/login`、`/logout`。

## 角色策略

| 角色 | Pi 加载策略 |
| --- | --- |
| Partitioner | 无工具、无 context files、无 skills/extensions，模型跟随全局配置（或由 `PARTITIONER_MODEL` 覆盖），思维链永远关闭（`thinking=off`，若不支持则设为最低） |
| Planner | 只开放 `node,edge,read,bash`，加载 Grapher 显式 planning extension，不加载项目 context/自动扩展 |
| Node Agent | 开放 Pi 原生工具，允许受信工作区的 skills/extensions |
| Merger | 固定冲突修复 prompt 和工具，不加载项目 context/自动扩展 |

生产入口为安装目录内的 `engine/entrypoint.mjs`，通过宿主 Node 启动锁定 Pi。Planner/Partitioner/Serial/Merger 在源项目真实绝对路径执行，复用宿主 PATH、HOME、TMPDIR、原生程序与外部文件。Windows 与 macOS 均保留完整 Graph 执行；Windows Graph 由 backend helper 使用 AppContainer 启动并授予每实例最小文件访问范围。会话与 Planner 编译器均使用真实宿主路径。源目录角色保持原生工具行为；Graph 路径适配及呈现规则见下文。历史配置中的 command/args 只在 `fixture` 测试构建可注入。

**项目内相对、项目外绝对**：节点任务、交付和生成配置优先采用项目根相对路径。Graph 模型侧普通物理路径呈现为 `./...`，结构化 URI 保持有效的源项目绝对地址；文件工具和 bash 完整绝对项目路径适配作为兼容层保留。`cd`/`../` 保持原生语义，外部兄弟目录需明确绝对路径。宿主原生执行、外部脚本及 Seatbelt 保护保留。脚本文件内部硬编码路径和程序动态拼接路径仍不透明映射；这不是内核目录重映射。完整边界见 [native-execution.md](native-execution.md)。

Graph 首次执行将经过 baseline 校验的 Pi 及已安装依赖复制到源项目外，一份副本供本 backend 的节点共享，解决自托管与目录保护冲突。节点只能读取这份引擎。无需密码或特权组件；没有 Docker/VM/chroot 后备路径。完整逻辑与验证见 [native-execution.md](native-execution.md)。

后端会清除继承的 `PI_MODEL`、`PI_THINKING`、`PI_PROVIDER`、`PI_REASONING_LEVEL`、`PI_SESSION_ID` 和 `PI_SESSION_FILE`，再按角色显式传入模型、thinking、session 和 `GRAPHER_MODE`。

## Provider/Auth Adapter

Adapter 支持 upstream provider catalog、login、poll、交互响应、cancel 和 logout。长期凭据及刷新逻辑留在 upstream `ModelRuntime`；浏览器只接收非敏感状态并提交当前认证交互所需输入。宿主 Adapter、`npm run pi` 和原生执行共享专用 `~/.grapher/pi-agent`（或 `PI_CODING_AGENT_DIR`）。不读取或自动复制旧 `~/.pi/agent` 凭据。`test:pi` 在隔离的空认证目录中测试真实 CLI 版本与 Provider/Auth IPC catalog（包括关闭输入后的完整输出），不调用付费模型。

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
4. 使用新 upstream 的 lockfile 安装依赖（`npm ci --prefix pi`），并运行 `npm --prefix pi run hydrate:model-data`。
5. 运行 `npm run pi:adopt -- <完整的 40 位 SHA>`：在确认 Pi 工作树干净且模型数据有效后，生成新 `engine/pi-lock.json` 并同步 `engine/model-data/`。审阅生成的变更，将父仓库 gitlink 一并提交。此命令不 fetch、pull 或跳过基线验证。
6. 先运行 `npm run pi:setup`，审阅 `engine/pi-compat.ts` 的源码级绑定，然后运行 `npm run pi:upgrade-check`（校验基线、离线构建、CLI/Provider/Auth 合约、类型、后端、extensions、native、bindings、HTTP）。此命令不调用付费模型，但 HTTP/benchmark 检查需要相邻的 `../grapher-tests` 测试仓库；仍需人工检查认证交互和真实模型调用。`test:native` 包含两个实际 Pi CLI 经生产 launcher 执行工具及绝对脚本的检查。
7. 若使用 fork commit，必须先推送到可公开获取的 remote，再更新 `.gitmodules` 并用全新 clone 验证。

基线更新、适配层修改和校验数据应在同一变更中提交。集中适配减少升级时的修改范围，**不保证任意上游版本的 API/行为兼容**：尤其是 Provider/Auth、扩展事件、工具语义和私有 CLI 入口，仍须通过实际回归验证。任何构建或合约测试失败都不能标记为可发布。
