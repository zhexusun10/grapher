import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "../pi/node_modules/esbuild/lib/main.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

await mkdir(path.resolve(".grapher"), { recursive: true });
const root = await mkdtemp(path.resolve(".grapher/ui-regression-"));

try {
  await build({
    entryPoints: {
      header: "src/components/layout/Header.tsx",
      approval: "src/components/modals/ApprovalModal.tsx",
      taskNode: "src/components/graph/TaskNode.tsx",
      timing: "src/components/ExecutionTiming.tsx",
      card: "src/components/ToolCallCard.tsx",
      planningCard: "src/components/PlanningSummaryCard.tsx",
      extension: "engine/prompt-extension.ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    nodePaths: ["pi/node_modules"],
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    jsx: "automatic",
    loader: { ".css": "empty" },
    external: ["react", "react-dom", "react/jsx-runtime", "motion", "lucide-react", "@xyflow/react"],
    outdir: root,
  });

  const { Header } = await import(pathToFileURL(path.join(root, "header.js")));
  const { ApprovalModal } = await import(pathToFileURL(path.join(root, "approval.js")));
  const { TaskNode, phaseText } = await import(pathToFileURL(path.join(root, "taskNode.js")));
  const { ExecutionTiming } = await import(pathToFileURL(path.join(root, "timing.js")));
  const { ToolCallCard } = await import(pathToFileURL(path.join(root, "card.js")));
  const { PlanningSummaryCard, calculateApprovalWaitingTime, calculatePausedTime, parseTimestamp } = await import(pathToFileURL(path.join(root, "planningCard.js")));
  const registerExtension = (await import(pathToFileURL(path.join(root, "extension.js")))).default;

  // Set up extension with mock Pi ExtensionAPI to capture bash tool and tool_result handlers
  let registeredBash = null;
  const listeners = new Map();
  const mockPi = {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    registerTool(tool) {
      if (tool.name === "bash") registeredBash = tool;
    },
  };
  registerExtension(mockPi);

  async function runBashThroughExtension(command) {
    const toolCallId = "tc-" + Math.random().toString(36).slice(2);
    let res;
    let isErr = false;
    try {
      res = await registeredBash.execute(toolCallId, { command }, null, () => {}, undefined);
    } catch (e) {
      isErr = true;
      res = { content: [{ type: "text", text: String(e) }] };
    }

    const event = {
      toolCallId,
      toolName: "bash",
      input: { command },
      isError: isErr || Boolean(res?.isError),
      details: res?.details,
    };

    for (const h of listeners.get("tool_result") || []) {
      const patch = await h(event);
      if (patch) Object.assign(event, patch);
    }

    const rawExitCode = event.details?.exitCode;
    const exitCode = typeof rawExitCode === "number" ? rawExitCode : null;
    const finalIsError = Boolean(event.isError || (exitCode !== null && exitCode !== 0));

    const textContent = Array.isArray(res?.content)
      ? res.content.map(c => c.text || "").join("\n")
      : (typeof res?.content === "string" ? res.content : "");

    return {
      id: toolCallId,
      toolName: "bash",
      status: finalIsError ? "error" : "success",
      args: { command },
      result: textContent,
      isError: finalIsError,
      exitCode,
      truncated: Boolean(event.details?.truncated),
    };
  }

  test("Header matches repoInfo against current config.repository and avoids stale project info", () => {
    // Case 1: Matching repository
    const matchedHtml = renderToStaticMarkup(createElement(Header, {
      config: { repository: "/path/to/my-project", engine: "pi", model: "qwen", maxParallel: 2, maxFeedback: 3 },
      repoInfo: { name: "my-project", path: "/path/to/my-project", isShadow: true },
      projects: [],
      runs: [],
      activeProject: null,
      onOpenSettings: () => {},
      onSelectProject: () => {},
      nodesCount: 3,
      eventsCount: 5,
    }));
    assert.match(matchedHtml, /my-project/);
    assert.match(matchedHtml, /影子仓库/);

    // Case 2: Stale repository info (different path) - must NOT show stale repo name or shadow tag
    const staleHtml = renderToStaticMarkup(createElement(Header, {
      config: { repository: "/path/to/new-folder", engine: "pi", model: "qwen", maxParallel: 2, maxFeedback: 3 },
      repoInfo: { name: "old-repo", path: "/path/to/old-repo", isShadow: true },
      projects: [],
      runs: [],
      activeProject: null,
      onOpenSettings: () => {},
      onSelectProject: () => {},
      nodesCount: 0,
      eventsCount: 0,
    }));
    assert.doesNotMatch(staleHtml, /old-repo/);
    assert.doesNotMatch(staleHtml, /影子仓库/);
    assert.match(staleHtml, /new-folder/);
  });

  test("ApprovalModal clearly shows writeback target directory and isolation", () => {
    const html = renderToStaticMarkup(createElement(ApprovalModal, {
      isOpen: true,
      state: {
        graph: { originalGoal: "Build catalog", nodes: [], edges: [] },
        config: { repository: "/target/user/repo", maxFeedback: 3 },
      },
      config: { repository: "/fallback/repo", maxFeedback: 3 },
      busy: false,
      onAdjustPlan: () => {},
      onApprove: () => {},
      onClose: () => {},
    }));
    assert.match(html, /整图完成后会将结果写回 \/target\/user\/repo/);
    assert.doesNotMatch(html, /完全不修改或破坏你的主开发目录/);
  });

  test("TaskNode displays '尚未执行' when attempts is 0 and '#N 尝试' when attempts > 0", async () => {
    const { ReactFlowProvider } = await import("@xyflow/react");
    const renderNode = (props) => renderToStaticMarkup(
      createElement(ReactFlowProvider, null, createElement(TaskNode, props))
    );

    const unattemptedHtml = renderNode({
      id: "node-1",
      data: {
        name: "node-1",
        status: "waiting",
        attempts: 0,
        revision: 1,
        instruction: "",
      },
    });
    assert.match(unattemptedHtml, /尚未执行/);
    assert.doesNotMatch(unattemptedHtml, /就绪/);

    const attemptedHtml = renderNode({
      id: "node-2",
      data: {
        name: "node-2",
        status: "running",
        attempts: 2,
        revision: 1,
        instruction: "",
      },
    });
    assert.match(attemptedHtml, /#2 尝试/);
  });

  test("ExecutionTiming renders timestamps and duration correctly for completed execution", () => {
    const startedAt = 1726300000000;
    const completedAt = 1726300125000; // 125 seconds = 2m 5s
    const html = renderToStaticMarkup(createElement(ExecutionTiming, {
      execution: {
        id: "e-1",
        node: "n-1",
        revision: 1,
        attempt: 1,
        sessionId: "s-1",
        worktree: "/wt",
        before: "b",
        after: "a",
        status: "done",
        output: "",
        startedAt,
        completedAt,
      },
    }));
    assert.match(html, /execution-timing/);
    assert.match(html, /耗时 2分5秒/);
  });

  test("phaseText dictionary accurately maps states", () => {
    assert.equal(phaseText.running, "执行中");
    assert.equal(phaseText.needs_attention, "需要介入");
    assert.equal(phaseText.completed, "已完成");
    assert.equal(phaseText.paused, "已暂停");
  });

  test("ToolCallCard provides structured exit status across the critical cases (V2-2 & V3-2) via real bash execution through prompt extension", async () => {
    // Case 1: Output contains 'Command exited with code 1' but process exit code is 0
    // Must NOT be tricked by regex scraping in output! Real process exitCode is 0.
    const case1Item = await runBashThroughExtension('printf "Command exited with code 1\\n"');
    assert.equal(case1Item.exitCode, 0, "printf command should have exit code 0");
    assert.equal(case1Item.isError, false, "printf command should not be marked as error");
    const case1Html = renderToStaticMarkup(createElement(ToolCallCard, { item: case1Item }));
    assert.match(case1Html, /完成 \(Exit 0\)/);
    assert.doesNotMatch(case1Html, /包含警告\/错误/);
    assert.doesNotMatch(case1Html, /失败/);

    // Case 2: Silent failure with non-zero exit code (exit 7)
    // Must NOT report green just because output is empty! Real process exitCode is 7.
    const case2Item = await runBashThroughExtension("exit 7");
    assert.equal(case2Item.exitCode, 7, "exit 7 command should have exit code 7");
    assert.equal(case2Item.isError, true, "exit 7 command should be marked as error");
    const case2Html = renderToStaticMarkup(createElement(ToolCallCard, { item: case2Item }));
    assert.match(case2Html, /失败 \(Exit 7\)/);
    assert.doesNotMatch(case2Html, /完成/);

    // Case 3: Pipeline failure 'false | true; true' under pipefail
    // Must fail because 'false | true' fails with code 1, and 'set -e' aborts before '; true'
    const case3Item = await runBashThroughExtension("false | true; true");
    assert.equal(case3Item.exitCode, 1, "piped failure should have exit code 1");
    assert.equal(case3Item.isError, true, "piped failure should be marked as error");
    const case3Html = renderToStaticMarkup(createElement(ToolCallCard, { item: case3Item }));
    assert.match(case3Html, /失败 \(Exit 1\)/);
    assert.doesNotMatch(case3Html, /完成/);

    // Case 4: Real process exit code 2
    const case4Item = await runBashThroughExtension(`${process.execPath} -e "process.exit(2)"`);
    assert.equal(case4Item.exitCode, 2, "process.exit(2) should have exit code 2");
    assert.equal(case4Item.isError, true, "process.exit(2) should be marked as error");
    const case4Html = renderToStaticMarkup(createElement(ToolCallCard, { item: case4Item }));
    assert.match(case4Html, /失败 \(Exit 2\)/);
    assert.doesNotMatch(case4Html, /完成/);

    // Case 5: Unknown / null exit code (interrupted or synthetic error without exit code)
    // Must display '失败 (退出码未知)' instead of faking 'Exit 1'
    const case5Item = {
      id: "call-unk",
      toolName: "bash",
      status: "error",
      args: { command: "sleep 10" },
      result: "Process interrupted",
      isError: true,
      exitCode: null,
    };
    const case5Html = renderToStaticMarkup(createElement(ToolCallCard, { item: case5Item }));
    assert.match(case5Html, /失败 \(退出码未知\)/);
    assert.doesNotMatch(case5Html, /Exit 1/);

    // Case 6: Non-bash tool (e.g. read/write tool)
    // Non-bash tools do not have bash process exit codes; must display clean '完成' or '失败' without 'Exit'
    const nonBashItem = {
      id: "call-read",
      toolName: "read",
      status: "success",
      args: { path: "src/index.ts" },
      result: "export const x = 1;",
      isError: false,
    };
    const nonBashHtml = renderToStaticMarkup(createElement(ToolCallCard, { item: nonBashItem }));
    assert.match(nonBashHtml, /完成/);
    assert.doesNotMatch(nonBashHtml, /Exit/);

    // Case 7: Truncation indicator & structured metadata bar
    const truncatedHtml = renderToStaticMarkup(createElement(ToolCallCard, {
      item: {
        id: "call-trunc",
        toolName: "bash",
        status: "success",
        args: { command: "git log" },
        result: "[Showing lines 1-10 of 500. Full output: /tmp/log.txt]",
        truncated: true,
        exitCode: 0,
      },
      defaultExpanded: true,
    }));
    assert.match(truncatedHtml, /已截断/);
    assert.match(truncatedHtml, /退出码:/);
    assert.match(truncatedHtml, /已截断 \(Truncated\)/);
  });

  test("PlanningSummaryCard renders persisted planning metrics, time breakdown, and tokens without exposing internal reasoning", () => {
    const mockPlanning = {
      planningId: "plan-abcd-12345678",
      roles: {
        partition: {
          model: "qwen-2.5-coder",
          durationSeconds: 12.4,
          assistantMessages: 1,
          tools: 0,
          toolErrors: 0,
          usage: { input: 1200, output: 350, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 1550 },
        },
        planner: {
          model: "qwen-2.5-coder",
          durationSeconds: 45.8,
          assistantMessages: 4,
          tools: 6,
          toolErrors: 1,
          usage: { input: 8500, output: 2100, cacheRead: 500, cacheWrite: 0, reasoning: 300, totalTokens: 11400 },
        },
      },
      totalPlanningDuration: 61.5,
      modelDuration: 58.2,
    };

    const mockStateApproved = {
      runId: "run-101",
      approved: true,
      events: [
        { sequence: 1, timestamp: 1726300000000, type: "created" },
        { sequence: 2, timestamp: 1726300030000, type: "approved" }, // 30s waiting time
      ],
    };

    // Case 1: Approved state
    const approvedHtml = renderToStaticMarkup(createElement(PlanningSummaryCard, {
      planning: mockPlanning,
      state: mockStateApproved,
      defaultExpanded: true,
    }));

    assert.match(approvedHtml, /规划阶段摘要/);
    assert.match(approvedHtml, /plan-abc/);
    assert.match(approvedHtml, /qwen-2\.5-coder/);
    assert.match(approvedHtml, /Pi 会话耗时/);
    assert.match(approvedHtml, /58\.2s/);
    assert.match(approvedHtml, /审批等待/);
    assert.match(approvedHtml, /30\.0s/);
    assert.match(approvedHtml, /规划耗时/);
    assert.match(approvedHtml, /1分1秒/); // 61.5s
    assert.match(approvedHtml, /1 错/); // 1 tool error
    assert.match(approvedHtml, /Token 资源消耗/);
    assert.match(approvedHtml, /12,950/); // total tokens = 1550 + 11400

    // Robust timestamp parsing tests
    assert.equal(parseTimestamp(1726300000000), 1726300000000);
    assert.equal(parseTimestamp("1726300000000"), 1726300000000);
    assert.equal(parseTimestamp("2026-09-14T01:33:35.732Z"), new Date("2026-09-14T01:33:35.732Z").getTime());
    assert.equal(parseTimestamp(null), 0);

    // Case 2: Failure planning state
    const failedHtml = renderToStaticMarkup(createElement(PlanningSummaryCard, {
      planning: {
        ...mockPlanning,
        status: "failed",
        error: "Partitioner returned an invalid route",
      },
    }));
    assert.match(failedHtml, /规划未通过：Partitioner returned an invalid route/);

    // Check footer note clarifies SQLite authority and avoids unconditional claims
    assert.match(approvedHtml, /运行态生命周期以 SQLite 事件为权威源/);
    assert.doesNotMatch(approvedHtml, /完全对账/);

    // Check no thought leakage
    assert.doesNotMatch(approvedHtml, /thought/i);
    assert.doesNotMatch(approvedHtml, /reasoningContent/i);

    // Case 2: Approval waiting calculation
    const waitApproved = calculateApprovalWaitingTime(mockPlanning, mockStateApproved, 1726300050000);
    assert.equal(waitApproved.isWaiting, false);
    assert.equal(waitApproved.durationSeconds, 30);

    const mockStateWaiting = {
      runId: "run-102",
      approved: false,
      events: [
        { sequence: 1, timestamp: 1726300000000, type: "created" },
      ],
    };
    const waitActive = calculateApprovalWaitingTime(mockPlanning, mockStateWaiting, 1726300045000);
    assert.equal(waitActive.isWaiting, true);
    assert.equal(waitActive.durationSeconds, 45);

    // Case 3: Paused time calculation
    const mockStatePaused = {
      runId: "run-103",
      events: [
        { sequence: 1, timestamp: 1726300000000, type: "created" },
        { sequence: 2, timestamp: 1726300010000, type: "paused", paused: true },
        { sequence: 3, timestamp: 1726300025000, type: "paused", paused: false }, // 15s pause
      ],
    };
    const pausedSeconds = calculatePausedTime(mockStatePaused, 1726300030000);
    assert.equal(pausedSeconds, 15);
  });

  console.log("UI regression tests passed: Header matching, ApprovalModal target, TaskNode state, ExecutionTiming, PlanningSummaryCard.");
} finally {
  await rm(root, { recursive: true, force: true });
}
