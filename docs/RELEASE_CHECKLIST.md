# Release Checklist for v0.1.0-alpha.1

This checklist guides you through creating the first Grapher release.

## Pre-release preparation

### Code and documentation
- [x] README.md updated with project status section
- [x] README.md badges added (CI, License, Rust)
- [x] README.md first screen optimized for clarity
- [x] docs/architecture/why-compile.md created
- [x] CHANGELOG.md created with v0.1.0-alpha.1 entry
- [x] Release workflow created (.github/workflows/release.yml)
- [ ] Verify all tests pass: `npm run test:pi && npm test`
- [ ] Verify frontend builds: `npm run build`
- [ ] Verify backend builds: `cargo build --release --manifest-path backend/Cargo.toml`
- [ ] Manual smoke test on each platform (Linux, macOS, Windows)

### GitHub metadata
- [ ] Update repository description (see docs/github-metadata.md)
- [ ] Update topics (remove duplicates, add recommended ones)
- [ ] Create social preview image (1280×640)
- [ ] Upload social preview image to repository settings

### Issues and roadmap
- [ ] Create roadmap issues (see suggestions below)
- [ ] Add labels: `roadmap`, `help wanted`, `good first issue`, `enhancement`, `bug`, `platform`
- [ ] Pin 2-3 most important roadmap issues

## Creating the release

### 1. Verify version numbers
```bash
# Check package.json
grep '"version"' package.json
# Should show: "version": "0.1.0"

# Check backend/Cargo.toml
grep '^version' backend/Cargo.toml
# Should show: version = "0.1.0"
```

### 2. Create and push the tag
```bash
git tag -a v0.1.0-alpha.1 -m "Release v0.1.0-alpha.1"
git push origin v0.1.0-alpha.1
```

### 3. Monitor the release workflow
- Go to https://github.com/zhexusun10/grapher/actions
- Watch the "Release" workflow
- It will create a draft release with binaries for Linux, macOS, and Windows

### 4. Edit the release notes
- Go to https://github.com/zhexusun10/grapher/releases
- Edit the draft release
- Review the auto-generated release notes
- Add any additional context or breaking changes
- Verify all assets are attached:
  - grapher-linux-x64.tar.gz
  - grapher-linux-x64.tar.gz.sha256
  - grapher-macos-x64.tar.gz
  - grapher-macos-x64.tar.gz.sha256
  - grapher-windows-x64.zip
  - grapher-windows-x64.zip.sha256

### 5. Test the release artifacts
Download and test each platform binary before publishing:

**Linux:**
```bash
wget https://github.com/zhexusun10/grapher/releases/download/v0.1.0-alpha.1/grapher-linux-x64.tar.gz
tar xzf grapher-linux-x64.tar.gz
cd grapher-linux-x64
./start.sh
# Verify it starts on http://127.0.0.1:1421
```

**macOS:**
```bash
curl -LO https://github.com/zhexusun10/grapher/releases/download/v0.1.0-alpha.1/grapher-macos-x64.tar.gz
tar xzf grapher-macos-x64.tar.gz
cd grapher-macos-x64
./start.sh
```

**Windows:**
```powershell
# Download grapher-windows-x64.zip
# Extract
cd grapher-windows-x64
.\start.bat
```

### 6. Publish the release
- Once testing is complete, click "Publish release"
- The release is now live!

## Post-release

### Update documentation
- [ ] Add installation instructions using release binaries to docs/guides/installation.md
- [ ] Update README.md Quick Start with a "Download release" option

### Community engagement
- [ ] Announcement: Share in Pi community/Discord (if exists)
- [ ] Twitter/X: Share with technical details
- [ ] Hacker News: Prepare "Show HN" post (wait for next release or after fixing initial issues)

### Monitor and respond
- [ ] Watch for new issues
- [ ] Respond to installation problems
- [ ] Update CHANGELOG.md with any hotfix commits

## Suggested roadmap issues to create

These should be created as GitHub issues with the `roadmap` label:

1. **Packaging: Downloadable Grapher builds** (this release addresses this partially)
   - Label: `roadmap`, `good first issue`
   - Improve installation experience with self-contained bundles

2. **Improve first-run provider setup**
   - Label: `roadmap`, `ux`
   - Streamline authentication and model selection

3. **macOS sandbox strategy**
   - Label: `roadmap`, `platform`
   - Implement filesystem isolation for macOS Graph nodes

4. **Windows workspace isolation**
   - Label: `roadmap`, `platform`
   - Move beyond process isolation to filesystem sandbox

5. **Graph routing evaluation**
   - Label: `roadmap`, `architecture`
   - Measure and improve Partitioner/Planner quality

6. **Execution graph UX improvements**
   - Label: `roadmap`, `ux`, `help wanted`
   - Better visualization, controls, and feedback

7. **Provider compatibility matrix**
   - Label: `roadmap`, `documentation`
   - Test and document provider support status

8. **Performance optimization**
   - Label: `roadmap`
   - Reduce overhead in graph compilation and execution

## Release announcement template

**Title:** Show HN: Grapher – Compile coding-agent work into inspectable execution graphs

**Body:**
```
I built Grapher, a local coding-agent workbench that takes a different approach to multi-agent orchestration.

Instead of keeping a supervisor agent in the execution loop:
  Goal → Supervisor → Agent → Supervisor → Agent → ...

Grapher compiles the work structure upfront:
  Goal → Planner → Graph → Compiler → Runtime → Agents

Key differences:
- Explicit dependencies you can inspect before execution
- Deterministic scheduling (no LLM coordinator during execution)
- Workspace inheritance without conversation propagation
- Built on Pi (https://github.com/earendil-works/pi)

It's alpha software, but the core idea is working: for independent workstreams (frontend+backend, implementation+tests), compile the structure first, then execute deterministically.

Open source (MIT), runs locally, Rust runtime + React UI.

Would love feedback on the architecture approach and whether this resonates with anyone else's experience with multi-agent systems.

GitHub: https://github.com/zhexusun10/grapher
```

**Timing:** After initial issues are resolved and at least 2-3 external users have successfully installed it.

## Notes

- This is an alpha release; set expectations accordingly
- Focus on getting feedback from technically sophisticated early adopters
- Don't overpromise on stability or feature completeness
- Be responsive to installation issues in the first 48 hours
- Document any workarounds needed for platform-specific problems
