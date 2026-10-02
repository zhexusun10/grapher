#!/bin/bash
# Grapher GitHub 设置和 Issue 创建脚本
# 使用 GitHub CLI (gh) 自动完成 GitHub 网页端操作

set -e

echo "=================================================="
echo "  Grapher GitHub 自动化设置"
echo "=================================================="
echo ""

# 检查是否已登录 GitHub CLI
if ! gh auth status &>/dev/null; then
    echo "❌ 未登录 GitHub CLI"
    echo "请先运行: gh auth login"
    exit 1
fi

echo "✓ GitHub CLI 已登录"
echo ""

# 1. 更新 Repository Description 和 Topics
echo "📝 更新 Repository Description 和 Topics..."
echo ""

REPO="zhexusun10/grapher"

# 更新 description
gh repo edit $REPO --description "Local coding-agent workbench that compiles complex work into inspectable execution graphs."

# 更新 topics
gh repo edit $REPO \
  --add-topic coding-agent \
  --add-topic ai-coding \
  --add-topic agentic-ai \
  --add-topic multi-agent \
  --add-topic llm-agents \
  --add-topic developer-tools \
  --add-topic workflow-engine \
  --add-topic local-first \
  --add-topic rust

# 移除可能重复的 topics
gh repo edit $REPO --remove-topic multi-agent-system 2>/dev/null || true
gh repo edit $REPO --remove-topic multi-agent-systems 2>/dev/null || true

echo "✓ Repository description 和 topics 已更新"
echo ""

# 2. 创建 Labels（如果不存在）
echo "🏷️  创建 Labels..."
echo ""

# 创建 label 的函数
create_label() {
    local name=$1
    local color=$2
    local description=$3
    
    if gh label list -R $REPO | grep -q "^$name"; then
        echo "  - $name (已存在)"
    else
        gh label create "$name" --color "$color" --description "$description" -R $REPO
        echo "  + $name (已创建)"
    fi
}

create_label "roadmap" "0052cc" "Planned features and improvements"
create_label "help wanted" "008672" "Extra attention is needed"
create_label "good first issue" "7057ff" "Good for newcomers"
create_label "platform" "d4c5f9" "Platform-specific (Linux/macOS/Windows)"
create_label "ux" "d876e3" "User experience improvements"
create_label "architecture" "1d76db" "Architecture and design decisions"

echo ""
echo "✓ Labels 已创建"
echo ""

# 3. 创建 Roadmap Issues
echo "📋 创建 Roadmap Issues..."
echo ""

# Issue 1: Packaging
if ! gh issue list -R $REPO --search "Packaging and one-command installation" --state all | grep -q "Packaging"; then
    gh issue create -R $REPO \
        --title "Packaging and one-command installation" \
        --label "roadmap,good first issue" \
        --body "## Overview

Currently, users need to:
- Clone with submodules
- Install Node.js 22.19+, Rust, bubblewrap (Linux)
- Run \`npm ci\`, \`pi:setup\`, manual build

## Goal

Provide downloadable binaries that work with minimal setup.

## Status

- [x] Release workflow created (.github/workflows/release.yml)
- [ ] Test release artifacts on all platforms
- [ ] Add quick-install instructions to README
- [ ] Consider self-contained bundles (with Node.js runtime)
- [ ] Provide checksums and platform notes

## Related

- Release workflow: \`.github/workflows/release.yml\`
- Installation guide: \`docs/guides/installation.md\`"
    echo "  + Issue created: Packaging and one-command installation"
else
    echo "  - Issue exists: Packaging and one-command installation"
fi

# Issue 2: macOS sandbox
if ! gh issue list -R $REPO --search "macOS sandbox strategy" --state all | grep -q "macOS"; then
    gh issue create -R $REPO \
        --title "macOS sandbox strategy" \
        --label "roadmap,platform" \
        --body "## Overview

Currently, macOS Graph nodes don't have filesystem sandboxing.

## Goal

Implement sandbox isolation for macOS similar to Linux bubblewrap.

## Options to explore

- \`sandbox-exec\` (deprecated but still available)
- App Sandbox (more complex, requires entitlements)
- Other containerization approaches
- Process isolation improvements

## Current status

- Planning
- Need to research macOS sandboxing APIs
- Consider backwards compatibility

## Related

- \`docs/architecture/filesystem-isolation.md\`
- Linux implementation: \`backend/src/linux_sandbox.rs\`"
    echo "  + Issue created: macOS sandbox strategy"
else
    echo "  - Issue exists: macOS sandbox strategy"
fi

# Issue 3: Windows isolation
if ! gh issue list -R $REPO --search "Windows workspace isolation" --state all | grep -q "Windows"; then
    gh issue create -R $REPO \
        --title "Windows workspace isolation improvements" \
        --label "roadmap,platform" \
        --body "## Overview

Currently, Windows Graph nodes use process isolation only, not filesystem sandboxing.

## Goal

Implement filesystem isolation for Windows Graph workspaces.

## Challenges

- Windows lacks a direct bubblewrap equivalent
- Need to explore Windows-specific isolation mechanisms
- Must maintain backwards compatibility

## Options

- Windows Sandbox (requires Windows 10 Pro+)
- Job Objects with restricted access
- AppContainer isolation
- Third-party solutions

## Current status

- Planning
- Researching Windows isolation APIs

## Related

- \`docs/architecture/filesystem-isolation.md\`
- Current Windows implementation: process isolation only"
    echo "  + Issue created: Windows workspace isolation improvements"
else
    echo "  - Issue exists: Windows workspace isolation"
fi

# Issue 4: Graph routing quality
if ! gh issue list -R $REPO --search "Graph routing quality evaluation" --state all | grep -q "routing"; then
    gh issue create -R $REPO \
        --title "Graph routing quality evaluation" \
        --label "roadmap,architecture" \
        --body "## Overview

Measure and improve Partitioner and Planner quality.

## Goal

Understand when Graph routing works well and when it doesn't, then improve accordingly.

## Tasks

- [ ] Define routing quality metrics
  - When should Partitioner choose Graph vs Serial?
  - Graph plan quality indicators
  - Execution efficiency metrics
- [ ] Collect evaluation dataset
  - Real-world coding tasks
  - Edge cases
- [ ] Measure current performance
- [ ] Identify improvement opportunities
  - Better decomposition heuristics
  - Smarter dependency detection
  - Conflict prediction

## Current status

Planning

## Related

- \`engine/partitioner.mjs\`
- \`engine/planner.mjs\`
- \`docs/architecture/execution-model.md\`"
    echo "  + Issue created: Graph routing quality evaluation"
else
    echo "  - Issue exists: Graph routing quality"
fi

# Issue 5: Execution graph UX
if ! gh issue list -R $REPO --search "Execution graph UX improvements" --state all | grep -q "graph UX"; then
    gh issue create -R $REPO \
        --title "Execution graph UX improvements" \
        --label "roadmap,ux,help wanted" \
        --body "## Overview

Current graph UI works but could be more intuitive and informative.

## Ideas for improvement

- **Better node state visualization**
  - Clearer indicators for running/complete/failed/waiting
  - Progress indicators within nodes
  
- **Improved dependency relationships**
  - Visual distinction between data dependencies and feedback edges
  - Highlight critical path
  
- **Enhanced log navigation**
  - Filter logs by severity
  - Jump to specific tool calls
  - Better streaming performance
  
- **Real-time progress**
  - Estimated completion time
  - Resource usage indicators
  
- **Graph interaction**
  - Node expansion/collapse
  - Better zoom and pan controls
  - Export graph as image

## Current status

Collecting feedback and ideas

## Contributing

This is a good area for external contributions! UI/UX expertise welcome.

## Related

- \`src/components/ExecutionGraph.tsx\`
- \`src/components/NodeInspector.tsx\`"
    echo "  + Issue created: Execution graph UX improvements"
else
    echo "  - Issue exists: Execution graph UX"
fi

# Issue 6: Provider compatibility
if ! gh issue list -R $REPO --search "Provider compatibility matrix" --state all | grep -q "Provider"; then
    gh issue create -R $REPO \
        --title "Provider compatibility matrix" \
        --label "roadmap,documentation" \
        --body "## Overview

Document which providers work well with Grapher and any known issues.

## Goal

Create a comprehensive compatibility table in documentation.

## Tasks

- [ ] Test major providers
  - OpenAI (GPT-4, GPT-3.5)
  - Anthropic (Claude)
  - Others supported by Pi
- [ ] Document known issues
  - Rate limiting behavior
  - Model-specific quirks
  - Authentication gotchas
- [ ] Create compatibility table
- [ ] Add provider-specific setup notes
- [ ] Update installation guide

## Current status

Planning

## Related

- \`docs/guides/providers.md\`
- \`docs/guides/installation.md\`
- Pi provider support: \`pi/\`"
    echo "  + Issue created: Provider compatibility matrix"
else
    echo "  - Issue exists: Provider compatibility"
fi

echo ""
echo "✓ Roadmap issues 已创建"
echo ""

echo "=================================================="
echo "  ✅ GitHub 自动化设置完成！"
echo "=================================================="
echo ""
echo "已完成："
echo "  ✓ Repository description 更新"
echo "  ✓ Topics 优化（删除重复）"
echo "  ✓ Labels 创建"
echo "  ✓ 6 个 Roadmap issues 创建"
echo ""
echo "查看结果："
echo "  🌐 Repository: https://github.com/$REPO"
echo "  📋 Issues: https://github.com/$REPO/issues?q=label%3Aroadmap"
echo ""
echo "下一步："
echo "  1. 在 GitHub 上 pin 2-3 个最重要的 issues"
echo "  2. 运行测试: npm run test:pi && npm test"
echo "  3. 创建 release: 见 docs/RELEASE_CHECKLIST.md"
echo ""
