# Repository homepage settings

GitHub About fields are remote repository settings; committing Markdown does not update them. A maintainer with permission can edit **About → settings** on the repository page.

## Description

```text
Local coding-agent workbench built on Pi. Compile complex work into inspectable execution graphs, execute with a deterministic Rust runtime, and publish through Git.
```

## Homepage

Until an actual documentation site or hosted demo exists, link to installation:

```text
https://github.com/zhexusun10/grapher#quick-start
```

This is not a hosted application. Do not use a localhost address or an undeployed GitHub Pages URL.

## Topics

```text
coding-agent
multi-agent
agentic-ai
llm
rust
git
local-first
developer-tools
task-graph
deterministic-runtime
```

## Optional GitHub CLI update

Confirm the CLI is authenticated and you have permission. Inspect existing fields before changing remote settings:

```sh
gh repo view zhexusun10/grapher --json description,homepageUrl,repositoryTopics

gh repo edit zhexusun10/grapher \
  --description "Local coding-agent workbench built on Pi. Compile complex work into inspectable execution graphs, execute with a deterministic Rust runtime, and publish through Git." \
  --homepage "https://github.com/zhexusun10/grapher#quick-start" \
  --add-topic coding-agent,multi-agent,agentic-ai,llm,rust,git,local-first,developer-tools,task-graph,deterministic-runtime

gh repo view zhexusun10/grapher --json description,homepageUrl,repositoryTopics
```

## Documentation and assets

- [English product homepage](../README.md)
- [Chinese product homepage](../README.zh-CN.md)
- [Canonical documentation index](../docs/README.md)

The screenshot shows an approval-stage demo graph, not execution success or benchmark performance. Maintainer checks belong in development documentation or issue tracking, not the product README.
