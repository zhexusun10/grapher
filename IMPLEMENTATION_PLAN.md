# Planner write/edit 工具开放与 Schema 优化实施计划

> **Status:** draft — 仅为待实施计划，不表示工具已经开放。
> **Scope:** 给 Planner 开放 Pi 原生 write/edit，并精简 Planner 收到的工具声明。
> **Baseline:** 当前工作树；锁定版本为 [Pi 1.3.0](engine/pi-lock.json)。
> **Implementation:** [共享工具适配](engine/workspace-tools.ts)、[角色策略](engine/prompt-extension.ts)、[启动参数](backend/src/engine.rs)。

## 1. 决策与边界

同意只开放工具，不另外告诉 Planner 必须使用它们：原有提示词没有专门要求使用 read/bash，开放 write/edit 也不需要追加这样的要求。

- Planner 的基础工具变为 `node / edge / read / bash / write / edit`；保留已经允许的扩展/MCP 工具。
- 不新增 `planner.md`，也不修改现有 [Planner 提示词](backend/resources/prompts/planner.md)。
- 不新增“先写计划”“必须更新 Markdown”“目录变了请重读”等系统提示词、用户消息前缀或自动提醒。
- 工具描述只说明文件操作语义，不加入 Planner 角色职责或 Markdown 工作流指导。模型自行决定是否用这些工具编写/修改文档。
- 不限制为 `.md`，不新增 `planPath`、`markdown`、`append` 等参数，也不缩写现有字段名。Bash 原本就能写文件，这不是一个新的文件权限边界。
- 不修改 `pi/`、依赖版本或生成文件。只在 Grapher 的 Planner 专属工具定义上优化声明，Node Agent/Merger 的定义保持不变。
- 延续现有真实 worktree 选择、单写入者、稳定模型可见路径、快照与发布规则，不新增 Markdown 专用存储或交付通道。
- Markdown 是普通项目文件；执行图仍以 `node` / `edge` 和 Rust 编译结果为准，不增加第二份权威计划。

本轮只编写本计划，不实施下列代码变更。

## 2. 当前实现与需要改变的位置

| 位置 | 当前情况 | 计划变更 |
| --- | --- | --- |
| [backend/src/engine.rs](backend/src/engine.rs) | Planner 使用 `--exclude-tools edit,write,ls,find,grep` | 改为仅排除 `ls,find,grep`，继续避免会屏蔽扩展/MCP 工具的全局 allowlist |
| [backend/src/server.rs](backend/src/server.rs) | Planner 请求中的工具说明是 `node,edge,read,bash` | 同步加入 `write,edit`；实际暴露还必须由启动参数和引擎注册共同保证 |
| [engine/prompt-extension.ts](engine/prompt-extension.ts) | Planner 文件工具筛选为 `['read']`，Bash 单独注册 | 改为 `['read', 'write', 'edit']`，并且只为 Planner 传入声明优化策略 |
| [engine/workspace-tools.ts](engine/workspace-tools.ts) | 已复用原生 read/write/edit 等工厂，统一映射路径和归一化结果 | 在同一个注册入口支持可选的工具定义转换，不另写 IO 执行实现 |
| [backend/resources/planner.ts](backend/resources/planner.ts) | 只负责 node/edge 图操作 | 保持不变，不在这里重复注册 write/edit |

上游依据是 [write.ts](pi/packages/coding-agent/src/core/tools/write.ts) 和 [edit.ts](pi/packages/coding-agent/src/core/tools/edit.ts)。它们本身没有“只能写代码”的限制；优化的重点是声明去重，而不是把编码工具改造成 Markdown 专用工具。

## 3. Planner 专属声明的具体目标

这里的“声明”包含工具顶层 `description` 和参数 `parameters` 中的 JSON Schema。两层都要检查，不能只缩短顶层描述、却留下所有重复的字段说明。

### 3.1 write：保留整文件写入语义

目标顶层 `description`：

```text
Write the full contents of a file. Creates missing parent directories; overwrites existing files.
```

目标参数 schema：

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Project-relative or absolute file path."
    },
    "content": {
      "type": "string",
      "description": "Full file contents."
    }
  },
  "required": ["path", "content"],
  "additionalProperties": false
}
```

优化说明：

- 将“创建文件、覆盖已有文件、自动创建父目录”的重复叙述合并成一条简短描述，不能删除覆盖语义。
- `path` 只说明路径形式；`content` 只说明它是完整文件内容，不再重复文件创建/覆盖规则。
- `content: ""` 仍然合法，可以创建或清空文件。不得增加 `minLength`、内容长度上限或 Markdown 模式约束。
- 明确关闭未声明字段，避免模型生成原生工具不使用的附加参数。

### 3.2 edit：让每条约束只表达一次

目标顶层 `description`：

```text
Apply targeted replacements to one existing file.
```

目标参数 schema：

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Project-relative or absolute file path."
    },
    "edits": {
      "type": "array",
      "minItems": 1,
      "description": "Non-overlapping replacements, all matched against the original file.",
      "items": {
        "type": "object",
        "properties": {
          "oldText": {
            "type": "string",
            "minLength": 1,
            "description": "Exact, unique text to replace."
          },
          "newText": {
            "type": "string",
            "description": "Replacement text; empty deletes the match."
          }
        },
        "required": ["oldText", "newText"],
        "additionalProperties": false
      }
    }
  },
  "required": ["path", "edits"],
  "additionalProperties": false
}
```

优化说明：

| 语义 | 唯一主要表达位置 |
| --- | --- |
| 修改一个已有文件，而非创建文件 | 顶层 `description` |
| 所有匹配针对同一份原文件，而非按数组顺序逐步匹配 | `edits.description` |
| 修改区域不能重叠 | `edits.description`；跨项目匹配仍由 Pi 原生实现检查 |
| 匹配原文必须唯一，按精确文本提供 | `oldText.description` |
| 至少一项修改、oldText 不能为空 | `minItems: 1`、`minLength: 1`，对应 Pi 已有执行校验 |
| 删除一段文本 | 允许 `newText: ""`，并在该字段说明 |

删除多处重复的“唯一、不重叠、合并附近修改、不要填充大量未变内容”等长段落；保留准确调用所必需的约束。不要通过省略“针对原文件匹配”来换取更短的声明。

JSON Schema 不能判断文件内容中的匹配唯一性和跨 edits 的实际重叠，因此不能用上述静态 schema 替代 Pi 的原生校验。上游的换行归一化、有限模糊匹配、BOM/换行风格保留也全部保留，不自行改成新的替换算法。

### 3.3 与原生 schema 的差别和兼容要求

- 保留 `path/content`、`path/edits[]/oldText/newText` 的字段名、类型、必填关系和批量结构；不向模型宣传旧版顶层 `oldText/newText` 接口。
- `minItems` 和 `minLength` 是将已有执行约束显式表达给模型，不增加新的业务限制。不能给 `newText` 加非空限制，也不能用 `uniqueItems` 代替文本区域唯一性检查。
- `additionalProperties: false` 只约束标准声明中的字段；必须保留 Pi 的 `prepareArguments`，先完成原有兼容归一化，再验证参数。
- 保留 `constrainedSampling: { "type": "json_schema", "strict": "prefer" }`，不改成强制 strict，不自己实现 provider schema 转换。
- 核对实际发往 provider 的声明，而不只检查本地对象。新增关键字必须经过当前锁定 Pi 的转换兼容性测试；如果不能兼容项目支持的 provider 路径，应先解决并记录阻塞，不暗中添加另一套 provider 适配或修改 Pi。

### 3.4 不把 schema 优化变成提示词注入

- 不复制工具描述到 Planner system prompt，也不增加工具使用提醒。
- 不为 Planner 定制新的 `promptSnippet` / `promptGuidelines`；保留工厂返回的原有元数据，不主动将其追加到自定义 Planner 提示词中。
- 允许的模型输入变化是工具声明列表增加 write/edit，以及这两项声明采用上述更短的描述/schema；已有 system/user 消息的指令正文不因此改变。

## 4. 实施步骤

### 步骤 A：先实现纯声明优化，再接入角色策略

- [ ] 新增 `engine/planner-file-tools.ts`，集中处理 Planner 的 write/edit 声明，其他工具原样返回。
- [ ] 输入采用 Pi 工厂生成的 ToolDefinition，仅派生顶层 `description` 和 `parameters`；不从零复制工具实现。
- [ ] 按上面的目标逐层复制和修改 schema 节点，保留 TypeBox 必要元数据。不要原地修改工厂对象、共享嵌套 schema，也不要用 JSON 序列化往返充当 schema 克隆。
- [ ] 保留原生 `execute`、`prepareArguments`、渲染配置、结果 details、取消行为和文件修改队列。
- [ ] 如需新增 Pi 类型导出，只在 [pi-compat.ts](engine/pi-compat.ts) 统一添加；不新增分散的上游源码绑定或 schema 依赖。
- [ ] 在 `registerWorkspaceTools` 增加一个可选、带类型的工具定义转换入口，由角色策略传入优化函数。共享工具层不自行读取环境变量来判断角色。
- [ ] 只在 Planner 注册路径使用这个转换；Node Agent/Merger 的工具描述、schema 和执行行为保持原样。

### 步骤 B：开放工具并保留当前 workspace 行为

- [ ] 调整第 2 节中的启动排除项、Planner 请求工具说明和引擎注册名单。
- [ ] 每个工具只注册一次，write/edit 都走当前共享路径适配层。
- [ ] 映射仅作用于 `path`；绝不能改写 `content`、`oldText`、`newText` 的字节内容。
- [ ] 成功结果、错误、diff/patch 等沿用既有模型可见路径归一化；后台实际 cwd 和会话信息继续记录真实 worktree。
- [ ] 源目录、不同节点 worktree、发布后源目录之间切换时，工具始终绑定本轮选定目录，不缓存上一轮的可变工具状态。
- [ ] 复用已有 Planner 写入捕获：源目录修改走源快照，节点目录修改进入对应结果快照；失败/取消保留修改与证据。不要在文件工具 execute 中单独提交 Git。

### 步骤 C：更新验证和当前契约

- [ ] 新增 `scripts/planner-file-tools.test.ts`，加入 `package.json` 的 `test:pi` 测试清单，覆盖声明优化和原生调用兼容性。
- [ ] 更新 [Planner IO 测试](scripts/planner-bash.test.ts)、[扩展 smoke](scripts/check-pi-extension.ts)、[角色策略测试](scripts/global-extensions.test.ts) 和 [prepared-host 测试](scripts/prepared-host.test.mjs) 中原有 read/bash 工具范围断言。
- [ ] 更新 [原生启动测试](backend/src/native.rs) 和 [Planner workspace 回归](backend/src/planner_workspace_tests.rs)，验证真实工具调用、快照和发布，而非仅通过 Bash 模拟文件工具。
- [ ] 更新 [Pi 角色策略](docs/development/pi-integration.md)、[文件系统契约](docs/architecture/filesystem-isolation.md) 和相关测试入口说明；不要修改 Planner 提示词。
- [ ] 完成后将验证证据写入实施记录，再决定归档本计划；不能仅因文档已有目标 schema 就标记功能完成。

## 5. 验证矩阵

| 范围 | 必须验证的行为 |
| --- | --- |
| 声明优化 | 字段结构、必填字段、非空约束、关闭额外字段、原生 constrainedSampling 策略正确；未改变其他工具 |
| 不污染原生定义 | 先创建 Planner 工具、再创建 Node 工具，或反序创建，原生描述/schema 均不被共享对象修改污染 |
| 参数归一化 | 保留 Pi 现有 edits 数组/兼容输入归一化；验证经过真实 prepareArguments 与 schema 校验链路，不只直接调用 execute |
| write | 新文件、已有文件覆盖、自动建目录、空内容、Unicode/空格路径、取消和 IO 错误 |
| edit | 单项及多项替换、针对同一原文件匹配；空数组/空 oldText/重复匹配/重叠拒绝；空 newText 删除；一项匹配失败不写入部分结果 |
| 文本兼容 | CRLF、BOM、Markdown 代码块和含绝对路径的文本保持原生行为，不把正文中的路径改写成物理 worktree 路径 |
| 切换目录 | 源目录 → worktree A → worktree B → 源目录：相同逻辑 path 操作本轮目录；模型侧仍是稳定路径视图；Node 对照组不退化 |
| 无额外指令 | 开放前后自定义 Planner system prompt 和用户指令正文不因工具开放而增加内容；无 cwd/重读/强制 Markdown 提醒 |
| 实际模型声明 | 本地确定性 provider 捕获工具声明：基础工具包含 node/edge/read/bash/write/edit，不意外开放 ls/find/grep，不屏蔽允许的扩展工具；write/edit 确实采用优化后的 schema |
| 生命周期 | 初始规划、已运行图追加、失败/取消、重载后续聊；Markdown 修改可进入依赖继承和最终发布，不提前写回源目录 |
| 原生角色 | Partitioner 仍无工具；Node Agent/Merger 的原有工具 schema、权限、会话和路径策略不变 |

测试不要锁定描述文字的逐字拼写。结构与调用语义是契约；描述可以继续措辞优化。对优化前后的完整 write/edit 工具声明记录序列化字节数，确认减少重复信息；字节数不是精确 token 数，也不等于模型质量提升。

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
- 最终验收：Planner 收到更短且语义完整的 write/edit 声明，可以自行用它们修改普通项目文件；没有新增 Planner 提示词，没有修改 Pi，没有破坏稳定路径、原生工具行为或既有快照/发布规则。
