// Capture the real frontend with synthetic API data; no backend or credentials required.
// Run from the repository root with Playwright Chromium (Edge on Windows),
// or select an installed browser with GRAPHER_BROWSER_CHANNEL.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const repository = '/demo/video-forensics';
const config = {
  repository,
  model: 'demo/model',
  thinkingLevel: 'medium',
  maxParallel: 4,
  isolateParallelNodes: true,
  maxFeedback: 2,
  feedbackEnabled: true,
  autoApprove: false,
  postTaskReview: true,
  plannerWriteTools: true,
};
const empty = {
  runId: '',
  config: null,
  graph: { originalGoal: '', nodes: [], edges: [] },
  nodes: {},
  plan: null,
  executions: [],
  events: [],
  approved: false,
  paused: false,
  phase: 'draft',
  base: '',
  feedbackCounts: {},
};
const repoInfo = { path: repository, name: 'video-forensics', branch: 'main', head: '', clean: true };

const server = await createServer({
  cacheDir: 'node_modules/.vite-readme-capture',
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, open: false },
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    channel: process.env.GRAPHER_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chromium'),
    headless: true,
  });

  for (const lang of ['en', 'zh-CN']) {
    const zh = lang === 'zh-CN';
    const title = zh ? 'AI 视频检测工程流水线' : 'AI video detection pipeline';
    const goal = zh
      ? '在 src/forensics/ 中构建可复现的 AI 生成视频检测流水线：按来源分组冻结 train/val/test 划分并验证无泄漏；并行开发空间伪影、光流时序与 FFT/小波频域分支；仅在验证集完成分支审计、消融校准与有界鲁棒性反馈；最终在留出集评估一次并交付 CLI 与模型卡。'
      : 'Build a reproducible AI-generated video detection pipeline in src/forensics/. Freeze source-grouped train/val/test splits with leakage tests, then build spatial, temporal, and FFT/wavelet branches in parallel. Run validation checks, ablations, and bounded compression feedback on val before one holdout eval and CLI packaging.';

    // A reviewable demonstration plan, not a recording of a model run or a benchmark.
    const nodeSpecs = [
      [
        '01_package_scaffold',
        'Scaffold src/forensics/ package, YAML config schema, shared dataset loaders, and base pytest suite.',
        '搭建 src/forensics/ 包结构、YAML 配置规范、公共数据加载器与基础 pytest 测试套件。',
      ],
      [
        '02_data_audit_splits',
        'Deduplicate clip manifests, freeze source-grouped train/val/test splits, and enforce leakage tests.',
        '清洗去重样本清单，按来源分组冻结 train/val/test 划分并编写防泄漏校验测试。',
      ],
      [
        '03_spatial_branch',
        'Build RGB & noise-residual feature pipeline and train spatial CNN detector on train; save val logits.',
        '实现 RGB 与噪声残差特征管线并在训练集训练空间 CNN 检测器，保存验证集预测概率。',
      ],
      [
        '04_temporal_branch',
        'Extract optical-flow & flicker consistency signals and train compact GRU detector on train; log val.',
        '提取光流与帧间闪烁一致性特征，在训练集训练轻量 GRU 时序检测器并记录验证集结果。',
      ],
      [
        '05_freq_branch',
        'Build 2D-FFT radial & wavelet extractors and train spectral detector with augmentations on train.',
        '构建 2D-FFT 径向频谱与小波提取器，结合数据增强在训练集训练频域检测模型。',
      ],
      [
        '06_spatial_eval',
        'Calibrate spatial detector on val, audit lighting/codec error slices, and profile frame latency.',
        '在验证集校准空间模型概率，审计光照与编码分片误报率并测量单帧推理延迟。',
      ],
      [
        '07_temporal_eval',
        'Run val clip-length & FPS ablations on temporal detector and measure sequence memory footprint.',
        '在验证集开展片段长度与帧率消融实验，统计时序分支推理显存与吞吐耗时。',
      ],
      [
        '08_freq_robustness',
        'Stress-test frequency branch under H.264 CRF, resize & blur on val; send <FEEDBACK> if AUROC drops >5%.',
        '在验证集执行 H.264 压缩、缩放与模糊压力测试；若 AUROC 降幅 >5% 则向频域分支发送 <FEEDBACK>。',
      ],
      [
        '09_ensemble_selection',
        'Run cross-branch val ablations, fit late-fusion weights & threshold, and freeze configs/selected_model.json.',
        '基于验证集开展跨模态消融与融合权重校准，锁定阈值并冻结 configs/selected_model.json。',
      ],
      [
        '10_holdout_eval',
        'Run single locked evaluation on test split, plot ROC/PR & calibration curves, and log failure slices.',
        '在锁定留出测试集执行唯一一次评估，生成 ROC/PR 与校准曲线并汇总错误案例分片。',
      ],
      [
        '11_inference_bundle',
        'Export ONNX/TorchScript weights, build forensics-detect CLI, and add end-to-end CLI smoke tests.',
        '导出 ONNX/TorchScript 权重，封装 forensics-detect 命令行推理工具并补充端到端冒烟测试。',
      ],
      [
        '12_final_report',
        'Compile MODEL_CARD.md, ablation tables & reproducibility guide; run full pytest & CLI verification.',
        '汇总留出集指标、消融表与复现指南生成 MODEL_CARD.md，并运行全量 pytest 与 CLI 校验。',
      ],
    ];

    const nodes = nodeSpecs.map(([id, en, cn]) => ({ id, task: zh ? cn : en }));
    const names = nodes.map(node => node.id);
    assert.equal(new Set(names).size, 12, 'demo node names must be unique');

    const dependencies = [
      ['01_package_scaffold', '03_spatial_branch'],
      ['02_data_audit_splits', '03_spatial_branch'],
      ['01_package_scaffold', '04_temporal_branch'],
      ['02_data_audit_splits', '04_temporal_branch'],
      ['01_package_scaffold', '05_freq_branch'],
      ['02_data_audit_splits', '05_freq_branch'],
      ['03_spatial_branch', '06_spatial_eval'],
      ['04_temporal_branch', '07_temporal_eval'],
      ['05_freq_branch', '08_freq_robustness'],
      ['06_spatial_eval', '09_ensemble_selection'],
      ['07_temporal_eval', '09_ensemble_selection'],
      ['08_freq_robustness', '09_ensemble_selection'],
      ['09_ensemble_selection', '10_holdout_eval'],
      ['09_ensemble_selection', '11_inference_bundle'],
      ['10_holdout_eval', '12_final_report'],
      ['11_inference_bundle', '12_final_report'],
    ].map(([from, to]) => ({ from, to, feedback: false }));

    const edges = [...dependencies, { from: '08_freq_robustness', to: '05_freq_branch', feedback: true }];
    assert.equal(edges.length, 17);
    assert.equal(new Set(edges.map(edge => `${edge.from}:${edge.to}`)).size, edges.length, 'edges must be unique');
    assert.ok(edges.every(edge => names.includes(edge.from) && names.includes(edge.to) && edge.from !== edge.to));

    // Reject redundant direct dependency edges (mirrors compiler E209).
    const canReachWithout = (start, target, skipFrom, skipTo) => {
      const seen = new Set([start]);
      const queue = [start];
      while (queue.length) {
        const current = queue.shift();
        for (const edge of dependencies) {
          if (edge.from !== current) continue;
          if (edge.from === skipFrom && edge.to === skipTo) continue;
          if (edge.to === target) return true;
          if (!seen.has(edge.to)) {
            seen.add(edge.to);
            queue.push(edge.to);
          }
        }
      }
      return false;
    };
    for (const edge of dependencies) {
      assert.equal(canReachWithout(edge.from, edge.to, edge.from, edge.to), false,
        `Redundant edge ${edge.from} -> ${edge.to}`);
    }

    // Mirror the compiler's dependency batches; feedback does not impose ordering.
    const remaining = new Set(names);
    const executionBatches = [];
    while (remaining.size) {
      const ready = [...remaining].filter(name =>
        dependencies.every(edge => edge.to !== name || !remaining.has(edge.from))).sort();
      assert.ok(ready.length, 'demo dependencies must be acyclic');
      executionBatches.push(ready);
      for (const name of ready) remaining.delete(name);
    }
    assert.deepEqual(executionBatches.map(batch => batch.length), [2, 3, 3, 1, 2, 1]);

    const terminals = names.filter(name => !dependencies.some(edge => edge.from === name)).sort();
    assert.deepEqual(terminals, ['12_final_report']);

    const invalidated = new Set(['05_freq_branch']);
    for (const batch of executionBatches) {
      for (const name of batch) {
        if (dependencies.some(edge => edge.to === name && invalidated.has(edge.from))) invalidated.add(name);
      }
    }
    assert.ok(invalidated.has('08_freq_robustness'), 'feedback target must precede its source');
    assert.ok(!invalidated.has('06_spatial_eval') && !invalidated.has('07_temporal_eval'),
      'sibling branches remain unaffected by frequency feedback');

    const warning = `W303: If <FEEDBACK> is sent from 08_freq_robustness to 05_freq_branch, these nodes will rerun: ${[...invalidated].sort().join(', ')}.`;

    const snapshot = {
      ...empty,
      runId: 'demo-graph',
      title,
      config,
      planType: 'graph',
      planningId: 'demo-plan',
      planning: {
        planningId: 'demo-plan',
        roles: {
          planner: {
            model: 'demo/model',
            sessionId: 'demo-planner-session',
            sessionStart: '2026-11-18T09:15:00Z',
            durationSeconds: 18.4,
            assistantMessages: 2,
            tools: 3,
            toolErrors: 0,
            usage: { input: 14200, output: 1850, cacheRead: 9600, cacheWrite: 0, reasoning: 640, totalTokens: 26290 },
          },
        },
        totalPlanningDuration: 18.4,
        modelDuration: 16.9,
        status: 'completed',
        planType: 'graph',
        goal,
        runId: 'demo-graph',
      },
      phase: 'awaiting_approval',
      graph: { originalGoal: goal, nodes, edges },
      nodes: Object.fromEntries(names.map(name => [name, { status: 'waiting', revision: 0, head: null, instruction: '', error: null }])),
      plan: { executionBatches, rootNodes: executionBatches[0], terminals, warnings: [warning] },
      events: [{ sequence: 1, timestamp: 1, type: 'created', planning_id: 'demo-plan' }],
    };

    const thinkingText = zh
      ? '首先需隔离数据划分与包脚手架：先完成包接口与按来源分组的防泄漏划分，再展开空间、时序与频域三条相互独立的分支。\n\n为了严格遵守验证集选型原则，各分支在完成训练集拟合后先并行开展验证集切片审计与压缩鲁棒性压力测试，其中仅频域分支挂载返回 `05_freq_branch` 的有界 `<FEEDBACK>` 回路，确保返工不波及空间与时序分支。全部验证审计通过后再统一执行 `09_ensemble_selection` 冻结阈值，随后并行完成唯一一次留出集评估与 CLI 打包，最后汇总交付。'
      : 'Start by separating repository scaffolding and leakage-safe split freezing so all downstream feature pipelines consume identical manifest contracts.\n\nKeep the spatial, temporal, and frequency lanes decoupled (`03`/`06`, `04`/`07`, `05`/`08`) before merging into `09_ensemble_selection`. Placing `08_freq_robustness -> 05_freq_branch` as a bounded feedback edge lets compression-hardening rework rerun only the frequency lane and downstream fusion, leaving spatial and temporal results untouched. After `09_ensemble_selection` freezes `configs/selected_model.json`, holdout evaluation and CLI/ONNX packaging run in parallel before `12_final_report` verifies the complete suite.';

    const bashOut = [
      'pyproject.toml',
      'configs/dataset.yaml',
      'docs/DATASET_README.md',
      'data/manifests/clips_raw.parquet',
    ].join('\n');

    const readmeDoc = [
      '# Video Forensics Dataset Manifest',
      '- Clips: 48,000 real/synthetic videos across 14 generators and 1,240 source creators',
      '- Constraints: group splits by `creator_id` + perceptual hash cluster; evaluate `test` split exactly once',
    ].join('\n');

    const summaryText = zh
      ? '已检查仓库与数据集规范，并将流水线编译为 **12 个节点、6 个执行批次** 的有向图（含 1 条有界反馈回路）：\n\n- **基础与防泄漏（`01`–`02`）**：并行搭建 `src/forensics/` 工程与测试基线，同时按来源冻结 `train/val/test` 划分。\n- **三条独立分支（`03`–`08`）**：空间、时序、频域各自隔离研发与验证评估；`08_freq_robustness` 压测不达标时通过 `<FEEDBACK>` 仅驱动 `05_freq_branch` 返工。\n- **冻结与单次留出评估（`09`–`12`）**：`09_ensemble_selection` 锁定融合权重后，并行完成留出集评估（`10`）与 `forensics-detect` CLI 打包（`11`），由 `12_final_report` 汇总验证交付。'
      : 'Compiled a **12-node, 6-batch** execution graph with one bounded feedback loop:\n\n- **Foundation & leakage gate (`01`–`02`)**: Scaffold `src/forensics/` and `pytest` alongside source-grouped split freezing.\n- **Parallel modality lanes (`03`–`08`)**: Spatial, temporal, and frequency branches train and audit in isolation; `08_freq_robustness` sends bounded `<FEEDBACK>` to `05_freq_branch` only.\n- **Freeze, holdout & delivery (`09`–`12`)**: `09_ensemble_selection` locks weights on val, fanning out to holdout eval (`10`) and CLI bundle (`11`) before `12_final_report`.';

    const transcriptEvents = [
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: thinkingText }],
        },
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'inspect-repo',
        toolName: 'bash',
        args: { command: 'ls -la && find src configs -maxdepth 2' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'inspect-repo',
        toolName: 'bash',
        isError: false,
        durationMs: 84,
        result: { content: [{ type: 'text', text: bashOut }], details: { exitCode: 0 } },
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'read-dataset',
        toolName: 'read',
        args: { path: 'docs/DATASET_README.md' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'read-dataset',
        toolName: 'read',
        isError: false,
        result: { content: [{ type: 'text', text: readmeDoc }] },
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'graph',
        toolName: 'edit_graph',
        args: { nodes: nodes.map(({ id, task }) => ({ id, task })), edges },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'graph',
        toolName: 'edit_graph',
        isError: false,
        result: {
          content: [{ type: 'text', text: `Successfully applied ${nodes.length} node edit(s) and ${edges.length} edge edit(s).` }],
          details: {},
        },
      },
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: summaryText }],
        },
      },
    ];

    const content = transcriptEvents.map(x => JSON.stringify(x)).join('\n') + '\n';
    const bytes = Buffer.byteLength(content);

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1.5,
      locale: zh ? 'zh-CN' : 'en-US',
      reducedMotion: 'reduce',
      colorScheme: 'light',
    });
    await context.addInitScript(({ lang, repository, config, title }) => {
      localStorage.setItem('grapher_language_v1', lang);
      localStorage.setItem('grapher_plan_mode', 'graph');
      localStorage.setItem('grapher_projects', JSON.stringify([{
        id: repository,
        path: repository,
        name: 'video-forensics',
        branch: 'main',
        clean: true,
        lastOpened: 1,
      }]));
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
        case 'bootstrap':
        case 'save_config':
          result = {
            config,
            snapshot: empty,
            runs: ['demo-graph'],
            conversations: [{
              runId: 'demo-graph',
              repository,
              title,
              planType: 'graph',
              phase: 'awaiting_approval',
              hasActiveExecutions: false,
            }],
            repositoryInfo: repoInfo,
            dataPath: '/demo/.grapher',
          };
          break;
        case 'history':
        case 'snapshot':
          result = body.runId === 'demo-graph' ? snapshot : empty;
          break;
        case 'snapshot_if_changed':
          result = { version: 'demo', snapshot: body.runId === 'demo-graph' ? snapshot : null };
          break;
        case 'get_planning_output': {
          const offset = body.offset || 0;
          result = {
            planningId: body.planningId,
            role: 'planner',
            content: offset ? '' : content,
            startOffset: offset,
            nextOffset: bytes,
            totalBytes: bytes,
            complete: true,
            running: false,
          };
          break;
        }
        case 'get_file_changes':
          result = {
            runId: body.runId || 'demo-graph',
            executionId: null,
            executionIds: null,
            summary: {
              files: [],
              totalFiles: 0,
              addedCount: 0,
              modifiedCount: 0,
              deletedCount: 0,
              renamedCount: 0,
              totalAdditions: 0,
              totalDeletions: 0,
            },
          };
          break;
        case 'repository_status':
          result = { repository, valid: true, error: null };
          break;
        case 'detect_repository':
          result = repoInfo;
          break;
        case 'list_plannings':
          result = [];
          break;
        case 'list_files':
          result = { files: [] };
          break;
        case 'list_skills':
          result = { skills: [] };
          break;
        case 'provider_auth':
          result = { providers: [], models: [], warning: null };
          break;
        case 'pi_extensions':
          result = { globalDirectory: '/demo', extensions: [] };
          break;
        case 'environment_capabilities':
          result = { platform: 'macos', arch: 'arm64', nativeWorkspace: true };
          break;
        default:
          errors.push(`Unexpected API: ${command}`);
          result = null;
      }
      try {
        await route.fulfill({ json: { result } });
      } catch {
        /* A superseded poll can be aborted. */
      }
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

    // Overview card must stay hidden in default UI screenshots.
    assert.equal(await page.locator('.plan-summary-card').count(), 0);

    // History opens at the latest output; show the complete research goal and plan summary cleanly.
    await page.locator('.initial-query-scroll').evaluate(scroll => {
      scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -1200, bubbles: true }));
      scroll.scrollTop = 0;
    });
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.initial-query-scroll').evaluate(scroll => scroll.scrollTop), 0);
    assert.equal(await page.locator('.react-flow__node').count(), 12);
    const centerOffsets = await page.evaluate(() => {
      const center = selector => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return (rect.left + rect.right) / 2;
      };
      const axis = center('.initial-query-scroll');
      return ['.thinking-card', '.tool-call-card', '.pane-bottom-chat .prompt-box-container']
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
} finally {
  await browser?.close();
  await server.close();
}
