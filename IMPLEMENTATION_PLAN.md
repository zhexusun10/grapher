# Planner write/edit 工具开放实施计划

> **Status:** draft — 仅为待实施计划，不表示工具已经开放。
> **Scope:** 给 Planner 开放 Pi 原生 write/edit；工具声明原样透传，不做 Planner 专属 schema 优化。
> **Baseline:** 当前工作树；锁定版本为 [Pi 1.3.0](engine/pi-lock.json)。
> **Implementation:** [角色策略](engine/prompt-extension.ts)、[启动参数](backend/src/engine.rs)、[API](backend/src/server.rs)。

## 1. 决策与边界

同意只开放工具，不另外告诉 Planner 必须使用它们：原有提示词没有专门要求使用 read/bash，开放 write/edit 也不需要追加这样的要求。

- Planner 的基础工具变为 `node / edge / read / bash / write / edit`；保留已经允许的扩展/MCP 工具。
- 不新增 `planner.md`，也不修改现有 [Planner 提示词](backend/resources/prompts/planner.md)。
- 不新增“先写计划”“必须更新 Markdown”“目录变了请重读”等系统提示词、用户消息前缀或自动提醒。
- 工具声明原样透传：不覆盖 `description` / `parameters`，不新增 `minItems`、`minLength`、`additionalProperties` 等关键字。Planner 看到的 write/edit 与 Node Agent 逐字节一致，Grapher 层不引入任何 Planner 特有的写入先验。
- 不限制为 `.md`，不新增 `planPath`、`markdown`、`append` 等参数，也不缩写现有字段名。Bash 原本就能写文件，这不是一个新的文件权限边界。
- 不修改 `pi/`、依赖版本或生成文件。Node Agent/Merger 的工具定义保持不变。
- 延续现有真实 worktree 选择、单写入者、稳定模型可见路径、快照与发布规则，不新增 Markdown 专用存储或交付通道。
- Markdown 是普通项目文件；执行图仍以 `node` / `edge` 和 Rust 编译结果为准，不增加第二份权威计划。

本轮只编写本计划，不实施下列代码变更。

## 2. 当前实现与需要改变的位置

| 位置 | 当前情况 | 计划变更 |
| --- | --- | --- |
| [backend/src/engine.rs](backend/src/engine.rs) | Planner 使用 `--exclude-tools edit,write,ls,find,grep` | 改为仅排除 `ls,find,grep`，继续避免会屏蔽扩展/MCP 工具的全局 allowlist |
| [backend/src/server.rs](backend/src/server.rs) | Planner 请求中的工具说明是 `node,edge,read,bash` | 可选的元数据同步：该字符串对 Planner 不会传给 CLI（`--tools` 分支显式跳过 Planner），不影响实际暴露 |
| [engine/prompt-extension.ts](engine/prompt-extension.ts) | Planner 文件工具筛选为 `['read']`，Bash 单独注册 | 改为 `['read', 'write', 'edit']` |
| [engine/workspace-tools.ts](engine/workspace-tools.ts) | 已复用原生 read/write/edit 等工厂，统一映射路径和归一化结果 | 保持不变；不需要工具定义转换入口或 schema 改写 |
| [backend/resources/planner.ts](backend/resources/planner.ts) | 只负责 node/edge 图操作 | 保持不变，不在这里重复注册 write/edit |

上游依据是 [write.ts](pi/packages/coding-agent/src/core/tools/write.ts) 和 [edit.ts](pi/packages/coding-agent/src/core/tools/edit.ts)。它们本身没有“只能写代码”的限制。已核实 Pi 的 `buildRules` / tool guidelines（含 “Use write only for new files or complete rewrites.”）只在默认系统提示词分支注入；Planner 走 `--system-prompt`（customPrompt）路径，开放 write/edit 不会给 Planner 系统提示词增加任何工具规则，对模型输入的唯一变化就是工具声明列表。

另一个已核实的关键约束：Pi 的 `_isAllowedTool` 对扩展注册的自定义工具同样应用 `--exclude-tools` 匹配，因此只在扩展筛选中加入 write/edit 而保留启动排除项，工具仍会被过滤。启动排除项与扩展注册名单两处必须同时修改，缺一不可。

## 3. 声明保持原样：不做 Planner 专属 schema 优化

曾考虑为 Planner 定制更短的 write/edit 声明，现已否决，理由留档：

- write 原生声明本身就很短（约 130 字符描述加 `path`/`content` 两个字段），任何改写收益不足 10 token，却需要新增派生模块、注册转换入口、共享对象污染测试和 provider 转换兼容性验证。
- edit 原生声明约 200 token/请求，是唯一有分量的优化点；但裁剪会同时删掉 “keep oldText small / do not pad with large unchanged regions / merge nearby changes” 等压低匹配失败率的引导。edit 失败重试常以 `write` 整文件重写收场，激进裁剪会经由重试路径间接抬高写入倾向。
- `minItems` / `minLength` / `additionalProperties: false` 只是把运行时已有校验换种方式再说一遍，收益接近零；新增关键字还必须通过锁定 Pi 的 provider schema 转换兼容性测试，属于为零收益自造验证面。

如果将来有实测证据支持优化 edit 声明，作为单独、可选的最小改动处理：只覆盖顶层 `description` 一个字符串并保留 anti-padding 意图，参数 schema 一字不动；不引入新关键字，不做批量 schema 节点复制。

### 3.1 不污染提示词（验收守门）

- 不复制工具描述到 Planner system prompt，也不增加工具使用提醒。
- 不为 Planner 定制新的 `promptSnippet` / `promptGuidelines`；保留工厂返回的原有元数据，不主动将其追加到自定义 Planner 提示词中。
- 允许的模型输入变化只有一项：工具声明列表增加 write/edit，声明内容与 Node Agent 完全一致；已有 system/user 消息的指令正文不因此改变。

## 4. 实施步骤

### 步骤 A：开放工具并保留当前 workspace 行为

- [ ] 同步修改 [backend/src/engine.rs](backend/src/engine.rs) 启动排除项为 `ls,find,grep` 与 [engine/prompt-extension.ts](engine/prompt-extension.ts) 注册名单为 `['read', 'write', 'edit']`（两处缺一不可，见第 2 节）；write/edit 与 read 走同一共享路径适配层，声明对象不做任何改写。
- [ ] 映射仅作用于 `path`；绝不能改写 `content`、`oldText`、`newText` 的字节内容。
- [ ] 成功结果、错误、diff/patch 等沿用既有模型可见路径归一化；后台实际 cwd 和会话信息继续记录真实 worktree。
- [ ] 源目录、不同节点 worktree、发布后源目录之间切换时，工具始终绑定本轮选定目录，不缓存上一轮的可变工具状态。
- [ ] 复用已有 Planner 写入捕获：源目录修改走源快照，节点目录修改进入对应结果快照；失败/取消保留修改与证据。不要在文件工具 execute 中单独提交 Git。

### 步骤 B：更新验证和当前契约

- [ ] 更新 [Planner IO 测试](scripts/planner-bash.test.ts)、[扩展 smoke](scripts/check-pi-extension.ts)、[角色策略测试](scripts/global-extensions.test.ts) 和 [prepared-host 测试](scripts/prepared-host.test.mjs) 中原有 read/bash 工具范围断言为 `read/bash/write/edit`。
- [ ] 更新 [原生启动测试](backend/src/native.rs) 和 [Planner workspace 回归](backend/src/planner_workspace_tests.rs)，验证真实工具调用、快照和发布，而非仅通过 Bash 模拟文件工具。
- [ ] 更新 [Pi 角色策略](docs/development/pi-integration.md)、[文件系统契约](docs/architecture/filesystem-isolation.md) 和相关测试入口说明；不要修改 Planner 提示词。
- [ ] 完成后将验证证据写入实施记录，再决定归档本计划；不能仅因文档已有目标行为就标记功能完成。

## 5. 验证矩阵

| 范围 | 必须验证的行为 |
| --- | --- |
| 声明透传 | 先创建 Planner 工具、再创建 Node 工具，或反序创建：Planner 的 write/edit 声明与原生工厂输出逐字节一致；无描述改写、无新增关键字、未污染共享对象、未改变其他工具 |
| write | 新文件、已有文件覆盖、自动建目录、空内容、Unicode/空格路径、取消和 IO 错误 |
| edit | 单项及多项替换、针对同一原文件匹配；空数组/空 oldText/重复匹配/重叠拒绝；空 newText 删除；一项匹配失败不写入部分结果 |
| 文本兼容 | CRLF、BOM、Markdown 代码块和含绝对路径的文本保持原生行为，不把正文中的路径改写成物理 worktree 路径 |
| 切换目录 | 源目录 → worktree A → worktree B → 源目录：相同逻辑 path 操作本轮目录；模型侧仍是稳定路径视图；Node 对照组不退化 |
| 无额外指令 | 开放前后自定义 Planner system prompt 和用户指令正文不因工具开放而增加内容；无 cwd/重读/强制 Markdown 提醒，无 write/edit 使用规则注入 |
| 实际模型声明 | 本地确定性 provider 捕获工具声明：基础工具包含 node/edge/read/bash/write/edit，不意外开放 ls/find/grep，不屏蔽允许的扩展工具 |
| 生命周期 | 初始规划、已运行图追加、失败/取消、重载后续聊；Markdown 修改可进入依赖继承和最终发布，不提前写回源目录 |
| 原生角色 | Partitioner 仍无工具；Node Agent/Merger 的原有工具 schema、权限、会话和路径策略不变 |

测试不要锁定描述文字的逐字拼写。结构与调用语义是契约；上游措辞变化不构成回归。

## 6. 计划中的验证命令与验收条件

以下命令在实施后执行，本次文档编写不运行功能套件：

```sh
npm run check
npm run test:pi
npm run test:planner-bash
node --test scripts/workspace-paths.test.mjs scripts/prepared-host.test.mjs
node scripts/cargo.mjs check --manifest-path backend/Cargo.toml --no-default-features
node scripts/cargo.mjs test --manifest-path backend/Cargo.toml --no-default-features --features fixture --lib planner
npm run test:isolated -- --locked
npm run test:temporary -- test:extensions
npm run test:temporary -- test:native
```

- Windows 已运行后端不可被测试构建覆盖或停止；需要构建可执行文件的套件使用上面的临时 target 包装器。
- 使用临时项目、会话、数据和本地确定性 provider，不用真实用户数据，不运行付费模型，不安装/升级依赖。
- 原生文件系统行为需在实际平台验证；只在 Windows 通过不能宣称 Linux/macOS 也已验收。
- 最终验收：Planner 收到与 Node Agent 一致的原生 write/edit 声明，可以自行用它们修改普通项目文件；没有新增 Planner 提示词，没有 schema 改写，没有修改 Pi，没有破坏稳定路径、原生工具行为或既有快照/发布规则。
