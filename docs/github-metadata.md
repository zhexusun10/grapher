# GitHub Metadata Recommendations

This document contains recommendations for optimizing Grapher's GitHub metadata for better discoverability and first impressions.

## Repository Description (About)

**Current:** (check your GitHub repo settings)

**Recommended:**
```
Local coding-agent workbench that compiles complex work into inspectable execution graphs.
```

**Rationale:** 
- Uses search-friendly terms: "coding-agent", "workbench", "execution graphs"
- Explains what it is before how it works
- Under 70 characters, fits well on GitHub search results
- No implementation details (those belong in README)

## Topics

**Current topics to review for redundancy:**
- multi-agent
- multi-agent-system  
- multi-agent-systems

**Recommended topics (8-10 total):**
```
coding-agent
ai-coding
agentic-ai
multi-agent
llm-agents
developer-tools
workflow-engine
local-first
rust
```

**Rationale:**
- Removed duplicate multi-agent variants
- Focused on terms developers actually search for
- Mix of problem space (coding-agent, ai-coding) and solution space (workflow-engine, rust)
- "local-first" is increasingly popular search term
- Kept under 10 topics as recommended by GitHub

## Social Preview Image

**Recommended dimensions:** 1280×640 pixels

**Suggested content:**
```
Top: "Grapher" (logo/wordmark)
Middle: "Don't orchestrate agents. Compile work."
Bottom: Simple visual flow:
  Goal → Execution Graph → Deterministic Runtime
```

**Rationale:**
- This image appears when Grapher URLs are shared on Twitter, LinkedIn, Discord, etc.
- 1280×640 is GitHub's recommended size
- Simple, high-contrast design works best
- Should be readable even when scaled down
- Reinforces the core differentiation message

## Website URL

If you have documentation hosted elsewhere (e.g., GitHub Pages), add it to the repository settings. Otherwise, leave empty or use the GitHub repo URL.

## How to apply these changes

1. Go to https://github.com/zhexusun10/grapher
2. Click "Settings" (requires repo admin access)
3. Under "General":
   - Update "Description" 
   - Update "Topics" (click the gear icon next to About)
   - Upload "Social preview" image under "Social preview"
4. Save changes

## Additional recommendations

### README.md first screen
✅ Already improved in recent commit

### Badges
✅ Already added: Linux CI, Windows CI, MIT, Rust

### Project status section
✅ Already added to README

## Why this matters

- **GitHub search:** Topics and description affect internal GitHub search ranking
- **Google search:** Description becomes meta description in search results
- **Social sharing:** Social preview image is the first thing people see when someone shares a Grapher link
- **First impression:** Clear, search-friendly metadata helps developers quickly understand what Grapher is

## References

- [GitHub Topics documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics)
- [GitHub Social preview documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview)
- [GitHub README best practices](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)
