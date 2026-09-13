# Execution Instance Engine: Pi baseline

一次实际执行称为 **Execution Instance**；创建和驱动它的内核称为 **Execution Instance Engine**。Pi 是唯一生产实现。`fixture` 只是 Rust 编译期测试能力，不能用于出货。

## Ownership / capability boundary

- `/pi`：完整、未修改的 upstream 源码 submodule。包括 execution core、provider/API infrastructure、authentication、login、credential storage/refresh、模型配置、CLI、SDK 和扩展机制。此轮没有删除或迁移任何旧 Pi 代码。
- `backend/src/engine.rs`：Grapher 持有进程组、取消、超时、事件输出及 Execution Instance 生命周期；生产启动路径固定为 `engine/entrypoint.mjs`，不再信任历史配置中的任意可执行文件。测试构建保留进程替身注入。
- `engine/entrypoint.mjs`：校验源码基线并调用本地锁定依赖中的 tsx 与 upstream CLI；透传 stdin/stdout/stderr，不引入全局 Pi fallback。JSON instrumentation 仍使用 upstream 事件流，Grapher 在既有 execution/session 日志中消费它。
- `engine/model-data/`：upstream 官方 hydration 脚本生成的构建输入快照，不是另行维护的 provider 实现。新 upstream 不将这些 JSON 纳入 Git，因此仅锁 commit 不足以复现模型目录；这里补充逐文件 SHA-256。
- Provider/Auth Adapter 与前端交互尚待实现。必须委托 upstream `ModelRuntime` 的 provider discovery、auth interaction、login/logout 和 credential management，不能复制 provider 列表、OAuth 流程或凭据刷新逻辑。浏览器不可接收保存的 token/key；只可显示非敏感状态并提交用户输入。现阶段可通过 `npm run pi` 使用完整 upstream CLI 登录能力。

## Reproduce

```sh
git submodule update --init --recursive
npm run pi:setup     # 校验 commit/lock/checksum、npm ci、恢复固定模型目录
npm run pi:verify
npm run pi -- --version
npm run pi           # upstream 交互 CLI，包括 /login 和 /logout
npm run pi:build     # upstream 完整 build:offline；不会重新抓取浮动模型目录
```

需要 Node >=22.19、Git、npm；依赖安装需要网络及平台相关原生依赖。开发入口使用 upstream 源码与锁定的 tsx，不要求完整 dist 构建通过。这里承诺源码/依赖/模型目录输入可追踪，不承诺跨 OS/Node 的产物字节一致。

锁定详情见 `pi-lock.json`。当前 upstream/fork commit 均为 `71dca871bc80b6bc97be37f0ca3189399d651fff`，Pi 0.85.1；本地 fork 分支 `grapher/engine` 没有独立 patch。submodule URL 暂用可公开获取此 commit 的 upstream；没有推送或创建远程 fork 仓库。

### 已知 upstream 构建阻塞

`npm ci`、模型目录校验及源码 CLI `--version` 通过。完整 `build:offline` 在 `packages/ai/src/api/google-shared.ts:402` 失败：`FinishReason.TOO_MANY_TOOL_CALLS` 不能赋给 `never`。这是当前锁定 upstream/依赖组合的类型检查失败；未通过删除分支或改写 provider 来规避。完整发布构建必须在 upstream 修复后重新验证。

Grapher 验证：`npm run test:pi`、`npm run check`、`cargo check --no-default-features`、`cargo test --no-default-features --features fixture` 通过（Cargo 命令使用 `--manifest-path backend/Cargo.toml`）。无 fixture 的完整 `cargo test` 目前被已有 `tests/core.rs` 两处未门控的 `grapher::fixture` 引用阻塞；未改动这些既有测试逻辑。

## Sync upstream (explicit review, never floating update)

1. `npm run pi:verify`，确保子仓库无改动。保留父仓库现有修改；不要 reset/stash 他人工作。
2. 新 clone 中 remote 通常名为 `origin`；本次本地仓库名为 `upstream`。若缺少 upstream：`git -C pi remote add upstream https://github.com/earendil-works/pi.git`。
3. `git -C pi fetch upstream`，审阅并记录目标完整 SHA。创建/切换 fork 分支，显式 `git -C pi merge --ff-only <SHA>`。未来有必要 patch 时使用审阅过的 merge，不将旧备份自动应用。
4. 更新 `pi-lock.json` 的 upstream/fork SHA、package version 和依赖锁 SHA-256。用新 upstream 的 `npm ci` 和 `npm run hydrate:model-data` 获取新模型目录，整体更新 `engine/model-data/` 及每个校验和，不手工修 provider 数据。
5. 执行 setup、verify、完整 build、CLI smoke、Grapher 后端/HTTP/前端测试以及后续 Provider/Auth Adapter 合约测试。构建失败不得标记为可发布。
6. 同一次 Grapher 提交记录 gitlink、manifest、模型目录和适配层变更。不要在启动时执行 `git pull` 或 `submodule update --remote`。
7. 如未来需要独立 fork commit，先将其推送到可访问的 fork remote，再更新 `.gitmodules` URL 并验证全新 clone。当前不依赖任何未推送 commit。

## Original backup

完整旧目录（含 `.git`、原 index、工作区、未跟踪文件和 node_modules）位于：

`/Users/jerry/Desktop/grapher-pi-backup-20260913-164654/pi`

相邻保存 `index`、`index.patch`、`worktree.patch`、`status.txt`。原 index 与副本逐字节相同，备份前后 porcelain 状态 SHA-256 均为 `366c5a726b3c31ffa6208f4da0fc4ac94e8dff605b0d9fb563936b0eee8e02ac`。这是本机备份，不纳入版本库、不含自动迁移步骤。不要用它覆盖已注册的 submodule；需要旧环境时直接在备份目录检查或复制到独立位置。
