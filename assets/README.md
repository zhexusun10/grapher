# README screenshot

[`execution-graph.png`](execution-graph.png) is a capture of the actual Grapher React UI, in English, at 1600 × 900. It shows a **demo graph before user approval**:

```text
api_contract -> frontend --\
                           integration -> review
api_contract -> backend ---/      ^          |
                                  '--feedback'
```

The frontend/backend branches are independent after the shared contract. Review has one bounded feedback target: `integration`, which owns fixes to the combined result.

## Provenance and limits

- Captured with [`scripts/capture-readme.mjs`](../scripts/capture-readme.mjs) using Vite and Playwright; not a hand-drawn mockup.
- API responses are fixed demo data. No backend is started, no model is called, and no execution output, token usage, timing, or successful publication is fabricated.
- The browser uses an isolated context, synthetic `/demo/` paths, and no real credentials or runtime history. External HTTP requests and unexpected API calls fail the capture.
- This is a UI illustration, not evidence of model quality, execution success, benchmark results, or platform sandbox guarantees. See the README's execution boundaries for platform differences.
- The screenshot is generated from Grapher's own UI; no external stock assets are used.

## Reproduce

From the repository root, with Node.js 22.19+ and npm dependencies installed:

```sh
npm ci --ignore-scripts
# macOS/Linux: install Playwright's Chromium if it is not already available
npx playwright install chromium
node scripts/capture-readme.mjs
```

Windows uses installed Microsoft Edge by default. Other platforms use Playwright Chromium. To select another installed browser channel, set `GRAPHER_BROWSER_CHANNEL` (for example, `chrome`). The script starts a temporary localhost Vite server on a free port and closes its own server and browser after capture. It does not need Rust, Pi setup, provider authentication, or a running Grapher backend.

When the UI changes, regenerate the PNG and review it before committing. Keep the demo-data disclosure beside the image in both READMEs.
