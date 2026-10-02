# 立即行动清单

这是 Grapher v0.1.0-alpha.1 发布前的快速检查清单。

## ✅ 今天完成的代码改进

- [x] README.md 首屏优化（降低认知负担）
- [x] README.zh-CN.md 同步更新
- [x] 添加 CI badges（Linux, Windows, MIT, Rust）
- [x] 添加 Project Status 部分
- [x] 创建 "Why compile agent work?" 架构文档
- [x] 创建 Release workflow（支持 Linux/macOS/Windows）
- [x] 创建 CHANGELOG.md
- [x] 创建 Issue 模板（bug/feature/roadmap）
- [x] 创建 GitHub metadata 优化指南
- [x] 创建 Release checklist

## 🔧 GitHub 设置（5分钟）

### 方法一：使用 GitHub CLI 自动化脚本（推荐）

```bash
# 一键完成所有 GitHub 设置和 issue 创建
bash scripts/setup-github.sh
```

这个脚本会自动：
- ✅ 更新 repository description
- ✅ 优化 topics（删除重复）
- ✅ 创建 labels（roadmap, help wanted, etc.）
- ✅ 创建 6 个 roadmap issues

### 方法二：手动在 GitHub 网页端设置

访问 https://github.com/zhexusun10/grapher/settings

**1. 更新 Repository Description:**
```
Local coding-agent workbench that compiles complex work into inspectable execution graphs.
```

**2. 更新 Topics（去除重复）:**
```
coding-agent, ai-coding, agentic-ai, multi-agent, llm-agents,
developer-tools, workflow-engine, local-first, rust
```

**3. 创建 Issues:** 参考下方的 Issue 内容

### Social Preview 图片（可选，稍后完成）

尺寸：1280×640 像素  
内容建议见：docs/github-metadata.md

## 📋 Roadmap Issues 内容参考

如果使用 `scripts/setup-github.sh`，issues 会自动创建。
如果手动创建，以下是内容参考：

创建这些 issues 可以让项目看起来"正在发展"，而不是"已完成的静态代码"。

### Issue 1: Packaging and one-command installation
```markdown
**Labels:** roadmap, good first issue

Currently, users need to:
- Clone with submodules
- Install Node.js 22.19+, Rust, bubblewrap (Linux)
- Run npm ci, pi:setup, manual build

**Goal:** Provide downloadable binaries that work with minimal setup.

**Status:**
- [x] Release workflow created
- [ ] Test release artifacts on all platforms
- [ ] Add quick-install instructions to README
- [ ] Consider self-contained bundles
```

### Issue 2: macOS sandbox strategy
```markdown
**Labels:** roadmap, platform

Currently, macOS Graph nodes don't have filesystem sandboxing.

**Goal:** Implement sandbox isolation for macOS similar to Linux bubblewrap.

**Options to explore:**
- sandbox-exec
- App Sandbox
- Other containerization approaches

**Status:** Planning
```

### Issue 3: Windows workspace isolation
```markdown
**Labels:** roadmap, platform

Currently, Windows Graph nodes use process isolation only, not filesystem sandboxing.

**Goal:** Implement filesystem isolation for Windows Graph workspaces.

**Status:** Planning
```

### Issue 4: Graph routing quality evaluation
```markdown
**Labels:** roadmap, architecture

**Goal:** Measure and improve Partitioner and Planner quality.

**Tasks:**
- [ ] Define routing quality metrics
- [ ] Collect evaluation dataset
- [ ] Measure current performance
- [ ] Identify improvement opportunities

**Status:** Planning
```

### Issue 5: Execution graph UX improvements
```markdown
**Labels:** roadmap, ux, help wanted

Current graph UI works but could be more intuitive.

**Ideas:**
- Better node state visualization
- Clearer dependency relationships
- Improved log navigation
- Real-time progress indicators

**Status:** Collecting feedback
```

### Issue 6: Provider compatibility matrix
```markdown
**Labels:** roadmap, documentation

**Goal:** Document which providers work well with Grapher.

**Tasks:**
- [ ] Test major providers (OpenAI, Anthropic, etc.)
- [ ] Document known issues
- [ ] Create compatibility table in docs
- [ ] Add provider-specific setup notes

**Status:** Planning
```

### 创建 Labels（如果还没有）

在 https://github.com/zhexusun10/grapher/labels 创建：

- `roadmap` (purple/blue)
- `help wanted` (green)
- `good first issue` (green)
- `platform` (grey)
- `ux` (pink)
- `architecture` (blue)

## 🧪 发布前测试（30分钟）

```bash
# 1. 运行完整测试套件
npm run test:pi
npm test
npm run test:frontend
npm run test:extensions
npm run test:bindings

# 2. 验证构建
npm run build
npm run check

# 3. 本地测试生产模式
npm start
# 访问 http://127.0.0.1:1421，进行简单的 Serial 和 Graph 任务测试
```

## 🚀 发布 v0.1.0-alpha.1（按照 docs/RELEASE_CHECKLIST.md）

### 快速版本：

```bash
# 1. 确认版本号
grep '"version"' package.json
grep '^version' backend/Cargo.toml

# 2. 创建并推送 tag
git add -A
git commit -m "Prepare for v0.1.0-alpha.1 release"
git push
git tag -a v0.1.0-alpha.1 -m "Release v0.1.0-alpha.1"
git push origin v0.1.0-alpha.1

# 3. 监控 workflow
# 访问 https://github.com/zhexusun10/grapher/actions
# 等待 Release workflow 完成

# 4. 查看并编辑 draft release
# 访问 https://github.com/zhexusun10/grapher/releases
# 检查 artifacts，编辑 release notes，然后发布
```

## 📊 发布后监控（第一周）

### 每日检查：
- [ ] 新的 issues（特别是安装问题）
- [ ] CI 状态
- [ ] Star/fork 数量变化

### 响应策略：
- 安装问题 → 快速响应，更新文档
- Feature requests → 标记为 enhancement，说明 roadmap
- Bugs → 根据严重程度优先级处理

## 📢 社区推广（第二周开始）

### 阶段一：Pi 社区（如果存在）
如果 Pi 有 Discord/社区，可以写一个技术说明：
- 为什么选择在 Pi 上构建
- Grapher 的架构思想
- 邀请 Pi 用户试用

### 阶段二：技术内容分享
将 `docs/architecture/why-compile.md` 改写成独立技术文章：
- 发布在个人博客/Medium
- 分享到相关技术社区
- 不要硬广，专注技术讨论

### 阶段三：Hacker News（等待时机）
**不要立即发布。** 等待：
- 至少 2-3 个外部用户成功安装
- 主要安装问题已解决
- 有一些初期反馈和改进

**Show HN 标题建议：**
```
Show HN: Grapher – Compile coding-agent work into inspectable execution graphs
```

**帖子内容：** 见 docs/RELEASE_CHECKLIST.md

## ⏱️ 时间估算

| 任务 | 预计时间 |
|------|---------|
| GitHub 设置 | 5 分钟 |
| 创建 roadmap issues | 15 分钟 |
| 运行测试套件 | 30 分钟 |
| 发布 release | 20 分钟 |
| 测试 artifacts | 30 分钟 |
| **总计** | **~2 小时** |

## ✨ 完成后的状态

项目将从：
- "个人代码仓库"

变成：
- ✅ 有清晰定位的开源项目
- ✅ 展示工程质量的 CI badges
- ✅ 明确的 alpha 状态和功能清单
- ✅ 可下载的 release artifacts
- ✅ 社区贡献的基础设施（issues, templates）
- ✅ 可传播的架构思想文档
- ✅ 清晰的 roadmap

## 需要帮助？

- Release workflow 问题 → 查看 .github/workflows/release.yml
- Release 流程 → 查看 docs/RELEASE_CHECKLIST.md
- GitHub metadata → 查看 docs/github-metadata.md
- 整体改进总结 → 查看 docs/PRODUCT_IMPROVEMENTS_SUMMARY.md
