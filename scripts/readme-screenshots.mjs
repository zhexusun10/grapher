// Capture the real frontend with synthetic API data; no backend or credentials required.
// Run from the repository root with Playwright Chromium (Edge on Windows),
// or select an installed browser with GRAPHER_BROWSER_CHANNEL.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const repository = '/demo/video-forensics';
const config = { repository, model: 'demo/model', thinkingLevel: 'medium', maxParallel: 4, maxFeedback: 2, autoApprove: false };
const empty = { runId: '', config: null, graph: { originalGoal: '', nodes: [], edges: [] }, nodes: {}, plan: null, executions: [], events: [], approved: false, paused: false, phase: 'draft', base: '', feedbackCounts: {} };
const repoInfo = { path: repository, name: 'video-forensics', branch: 'main', head: '', clean: true };
const server = await createServer({ cacheDir: 'node_modules/.vite-readme-capture', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, open: false } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chromium'), headless: true });
  for (const lang of ['en', 'zh-CN']) {
    const zh = lang === 'zh-CN';
    const title = zh ? '视频检测研究流水线' : 'Video detection research pipeline';
    const goal = zh
      ? '构建可复现的 AI 生成视频检测流水线：审计数据并防止泄漏，并行研究视觉、频域与时序模型；仅用验证集选型，进行鲁棒性测试和一次最终留出集评估，交付代码、报告与部署包。'
      : 'Build a reproducible AI-generated video detection pipeline. Audit data and prevent leakage; develop visual, frequency and temporal models in parallel. Select on validation data, test robustness, evaluate once on the holdout set, and deliver code, reports and a deployment bundle.';
    // A reviewable demonstration plan, not a recording of a model run or a benchmark.
    const nodeSpecs = [
      ['01_data_audit', 'Audit sources, labels and duplicates.', '审计数据来源、标签与重复项。'],
      ['02_project_setup', 'Set up a reproducible research package.', '搭建可复现的研究项目。'],
      ['03_eval_protocol', 'Define metrics and holdout policy.', '定义评估指标和留出集规则。'],
      ['04_compute_plan', 'Plan compute and resource constraints.', '规划计算资源与约束。'],
      ['05_data_splits', 'Freeze source-level train, validation and test splits.', '冻结按来源划分的训练、验证与测试集。'],
      ['06_visual_features', 'Extract visual artifact features.', '提取视觉伪影特征。'],
      ['07_freq_features', 'Build FFT and wavelet features.', '构建 FFT 与小波特征。'],
      ['08_motion_features', 'Extract temporal and motion signals.', '提取时序与运动信号。'],
      ['09_baseline_models', 'Train visual baselines on training data.', '仅用训练集训练视觉基线模型。'],
      ['10_freq_models', 'Train frequency-domain candidates.', '训练频域候选模型。'],
      ['11_temporal_models', 'Train compact temporal candidates.', '训练轻量时序候选模型。'],
      ['12_leakage_audit', 'Verify split integrity and data lineage.', '检查数据划分与来源，排除泄漏。'],
      ['13_model_selection', 'Compare candidates on validation data.', '仅用验证集比较并选择模型。'],
      ['14_robustness', 'Stress-test the frequency model; send <FEEDBACK> when needed.', '对频域模型进行压力测试，必要时发送 <FEEDBACK>。'],
      ['15_perf_profile', 'Measure candidate inference latency and resources.', '测量候选模型的推理延迟与资源消耗。'],
      ['16_feature_analysis', 'Analyze baseline feature importance and errors.', '分析基线模型的特征重要性与错误模式。'],
      ['17_holdout_eval', 'Evaluate the selected model once on the holdout set.', '在留出测试集上评估选定模型一次。'],
      ['18_ablation', 'Run validation-set ablations and controls.', '在验证集上进行消融与对照实验。'],
      ['19_deployment', 'Package the selected model and inference code.', '打包选定模型和推理代码。'],
      ['20_interpretability', 'Summarize explanations and failure modes.', '汇总模型解释与失败案例。'],
      ['21_final_report', 'Deliver the results, reproducibility guide and artifacts.', '交付结果、复现指南与项目产物。'],
    ];
    const nodes = nodeSpecs.map(([name, en, cn]) => ({ name, task: zh ? cn : en }));
    const names = nodes.map(node => node.name);
    assert.equal(new Set(names).size, 21, 'demo node names must be unique');
    const dependencies = [
      ['01_data_audit', '05_data_splits'], ['03_eval_protocol', '05_data_splits'],
      ['02_project_setup', '06_visual_features'], ['02_project_setup', '07_freq_features'],
      ['02_project_setup', '08_motion_features'], ['04_compute_plan', '08_motion_features'],
      ['05_data_splits', '09_baseline_models'], ['06_visual_features', '09_baseline_models'],
      ['05_data_splits', '10_freq_models'], ['07_freq_features', '10_freq_models'],
      ['05_data_splits', '11_temporal_models'], ['08_motion_features', '11_temporal_models'],
      ['05_data_splits', '12_leakage_audit'],
      ...['09_baseline_models', '10_freq_models', '11_temporal_models', '12_leakage_audit'].map(from => [from, '13_model_selection']),
      ['10_freq_models', '14_robustness'],
      ...['09_baseline_models', '10_freq_models', '11_temporal_models'].map(from => [from, '15_perf_profile']),
      ['09_baseline_models', '16_feature_analysis'],
      ['13_model_selection', '17_holdout_eval'], ['14_robustness', '17_holdout_eval'],
      ['13_model_selection', '18_ablation'], ['14_robustness', '18_ablation'],
      ['13_model_selection', '19_deployment'], ['15_perf_profile', '19_deployment'],
      ['13_model_selection', '20_interpretability'], ['16_feature_analysis', '20_interpretability'],
      ...['17_holdout_eval', '18_ablation', '19_deployment', '20_interpretability'].map(from => [from, '21_final_report']),
    ].map(([from, to]) => ({ from, to, feedback: false }));
    const edges = [...dependencies, { from: '14_robustness', to: '10_freq_models', feedback: true }];
    assert.equal(edges.length, 35);
    assert.equal(new Set(edges.map(edge => `${edge.from}:${edge.to}`)).size, edges.length, 'edges must be unique');
    assert.ok(edges.every(edge => names.includes(edge.from) && names.includes(edge.to) && edge.from !== edge.to));
    // Mirror the compiler's dependency batches; feedback does not impose ordering.
    const remaining = new Set(names), executionBatches = [];
    while (remaining.size) {
      const ready = [...remaining].filter(name =>
        dependencies.every(edge => edge.to !== name || !remaining.has(edge.from))).sort();
      assert.ok(ready.length, 'demo dependencies must be acyclic');
      executionBatches.push(ready);
      for (const name of ready) remaining.delete(name);
    }
    assert.deepEqual(executionBatches.map(batch => batch.length), [4, 4, 4, 4, 4, 1]);
    const terminals = names.filter(name => !dependencies.some(edge => edge.from === name)).sort();
    assert.deepEqual(terminals, ['21_final_report']);
    const invalidated = new Set(['10_freq_models']);
    for (const batch of executionBatches) for (const name of batch) {
      if (dependencies.some(edge => edge.to === name && invalidated.has(edge.from))) invalidated.add(name);
    }
    assert.ok(invalidated.has('14_robustness'), 'feedback target must precede its source');
    const warning = `W303: If <FEEDBACK> from 14_robustness to 10_freq_models is applied, the target and dependency descendants will be invalidated: ${[...invalidated].sort().join(', ')}. Completed results must be recomputed; 10_freq_models continues from its own conversation history. Nodes outside this set are unaffected.`;
    const snapshot = { ...empty, runId: 'demo-graph', config, planType: 'graph', planningId: 'demo-plan',
      phase: 'awaiting_approval', graph: { originalGoal: goal, nodes, edges },
      nodes: Object.fromEntries(names.map(name => [name, { status: 'waiting', revision: 0, head: null, instruction: '', error: null }])),
      plan: { executionBatches, rootNodes: executionBatches[0], terminals, warnings: [warning] },
      events: [{ sequence: 1, timestamp: 1, type: 'created', planning_id: 'demo-plan' }] };
    const message = text => ({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } });
    const tools = [
      { type: 'tool_execution_start', toolCallId: 'read-project', toolName: 'bash', args: { command: 'ls && find src -maxdepth 2 -type f' } },
      { type: 'tool_execution_end', toolCallId: 'read-project', toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: 'Project structure inspected.' }] } },
      { type: 'tool_execution_start', toolCallId: 'nodes', toolName: 'node', args: { nodes } },
      { type: 'tool_execution_end', toolCallId: 'nodes', toolName: 'node', isError: false, result: { content: [{ type: 'text', text: 'Nodes created.' }] } },
      { type: 'tool_execution_start', toolCallId: 'edges', toolName: 'edge', args: { edges } },
      { type: 'tool_execution_end', toolCallId: 'edges', toolName: 'edge', isError: false, result: { content: [{ type: 'text', text: 'Dependencies created.' }] } },
    ];
    const text = zh
      ? '先冻结数据划分，再并行研究视觉、频域和时序模型；验证、鲁棒性测试与最终留出集评估完成后，整合结果并交付。鲁棒性检查可向频域模型发送有界反馈。'
      : 'First freeze the data splits, then explore visual, frequency and temporal models in parallel. Validation, robustness checks and a single holdout evaluation lead to the final delivery. A bounded feedback path returns robustness findings to the frequency model.';
    const content = [message(text), ...tools].map(x => JSON.stringify(x)).join('\n') + '\n';
    const bytes = Buffer.byteLength(content);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, locale: zh ? 'zh-CN' : 'en-US', reducedMotion: 'reduce', colorScheme: 'light' });
    await context.addInitScript(({ lang, repository, config, title }) => {
      localStorage.setItem('grapher_language_v1', lang);
      localStorage.setItem('grapher_plan_mode', 'graph');
      localStorage.setItem('grapher_projects', JSON.stringify([{ id: repository, path: repository, name: 'video-forensics', branch: 'main', clean: true, lastOpened: 1 }]));
      localStorage.setItem('grapher_workspace_runs', JSON.stringify({ [repository]: ['demo-graph'] }));
      localStorage.setItem('grapher_run_labels', JSON.stringify({ 'demo-graph': title }));
      localStorage.setItem('grapher_config', JSON.stringify(config));
      localStorage.setItem('grapher_workbench_split_ratio', '0.50');
    }, { lang, repository, config, title });
    const errors = [];
    await context.route('**/api/*', async route => {
      const command = new URL(route.request().url()).pathname.slice(5);
      const body = route.request().postDataJSON() || {};
      let result;
      switch (command) {
        case 'bootstrap': case 'save_config': result = { config, snapshot: empty, runs: ['demo-graph'], conversations: [{ runId: 'demo-graph', repository, title, planType: 'graph', phase: 'awaiting_approval', hasActiveExecutions: false }], repositoryInfo: repoInfo, dataPath: '/demo/.grapher' }; break;
        case 'history': case 'snapshot': result = body.runId === 'demo-graph' ? snapshot : empty; break;
        case 'snapshot_if_changed': result = { version: 'demo', snapshot: body.runId === 'demo-graph' ? snapshot : null }; break;
        case 'get_planning_output': {
          const offset = body.offset || 0;
          result = { planningId: body.planningId, role: 'planner', content: offset ? '' : content, startOffset: offset, nextOffset: bytes, totalBytes: bytes, complete: true, running: false };
          break;
        }
        case 'repository_status': result = { repository, valid: true, error: null }; break;
        case 'detect_repository': result = repoInfo; break;
        case 'list_plannings': result = []; break;
        case 'list_files': result = { files: [] }; break;
        case 'list_skills': result = { skills: [] }; break;
        case 'provider_auth': result = { providers: [], models: [], warning: null }; break;
        case 'pi_extensions': result = { globalDirectory: '/demo', extensions: [] }; break;
        case 'environment_capabilities': result = { platform: 'macos', arch: 'arm64', nativeWorkspace: true }; break;
        default: errors.push(`Unexpected API: ${command}`); result = null;
      }
      try { await route.fulfill({ json: { result } }); } catch { /* A superseded poll can be aborted. */ }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(90_000);
    page.setDefaultNavigationTimeout(90_000);
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: 'domcontentloaded' });
    await page.locator('.landing-screen').waitFor();
    await page.locator('.landing-screen textarea').fill(goal);
    await page.locator('.landing-screen textarea').blur();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
    assert.deepEqual(await page.locator('.landing-screen .prompt-box-mode-btn').allTextContents(), ['Serial', 'Graph']);
    await page.screenshot({ path: `assets/readme-home${zh ? '-zh' : ''}.png`, animations: 'disabled' });
    await page.locator('[data-run-id="demo-graph"]').click();
    await page.locator('.react-flow__node').first().waitFor();
    await page.getByRole('button', { name: zh ? '批准' : 'Approve', exact: true }).waitFor();
    await page.locator('.tool-call-card').first().waitFor();
    await page.waitForTimeout(1000);
    // History opens at the latest output; show the complete research goal in the overview.
    await page.locator('.initial-query-scroll').evaluate(scroll => {
      scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -1200, bubbles: true }));
      scroll.scrollTop = 0;
    });
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.initial-query-scroll').evaluate(scroll => scroll.scrollTop), 0);
    assert.equal(await page.locator('.react-flow__node').count(), 21);
    const centerOffsets = await page.evaluate(() => {
      const center = selector => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return (rect.left + rect.right) / 2;
      };
      const axis = center('.initial-query-scroll');
      return ['.tool-call-card', '.plan-summary-card', '.pane-bottom-chat .prompt-box-container']
        .filter(selector => document.querySelector(selector))
        .map(selector => ({ selector, offset: center(selector) - axis }));
    });
    assert.ok(centerOffsets.every(({ offset }) => Math.abs(offset) < 0.75),
      `cards and composer share a centerline: ${JSON.stringify(centerOffsets)}`);
    assert.equal(await page.getByText('Non-contiguous transcript append').count(), 0);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `assets/readme-graph${zh ? '-zh' : ''}.png`, animations: 'disabled' });
    console.log(`Captured ${lang} home and workbench`);
    await context.close();
  }
} finally { await browser?.close(); await server.close(); }
