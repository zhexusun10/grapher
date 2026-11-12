import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlow } from "@xyflow/react";
import { createServer } from "vite";

// A fresh process models a fresh page load, including module-level status labels.
const language = process.argv[2];
const preference = process.argv[3] || "auto";
const stored = new Map(preference === "auto" ? [] : [["grapher_language_v1", preference]]);
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
    removeItem: key => stored.delete(key),
  },
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { languages: [language], language },
});
const vite = await createServer({
  configFile: false, appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, watch: null, hmr: false, ws: false },
});
const noop = () => {};
const taskNodeCanvas = (component, data) => React.createElement(ReactFlow, {
  nodes: [{ id: data.name, type: "work", position: { x: 0, y: 0 }, width: 236, height: 180, data }],
  nodeTypes: { work: component }, width: 300, height: 240,
  proOptions: { hideAttribution: true },
});
try {
  const { defaultConfig: config, emptySnapshot, example } = await vite.ssrLoadModule("/src/types.ts");
  const { t, locale } = await vite.ssrLoadModule("/src/i18n/index.ts");
  const state = {
    ...emptySnapshot,
    graph: example,
    config,
    runId: "run-123",
    phase: "awaiting_approval",
    plan: {
      executionBatches: [["api_spec"], ["frontend", "backend"], ["qa_review"]],
      roots: ["api_spec"],
      terminals: ["qa_review"],
      warnings: ["W303: If <FEEDBACK> from qa_review to frontend is applied, the target and dependency descendants will be invalidated: frontend, qa_review. Completed results must be recomputed; frontend continues its conversation. Nodes outside this set are unaffected."],
    },
  };
  const mergerState = {
    ...state,
    approved: true,
    graph: { originalGoal: "merge", nodes: [{ name: "join", task: "Join results" }], edges: [] },
    nodes: { join: { status: "blocked", revision: 1, head: null, instruction: "", error: "conflict" } },
    mergers: [{ id: "merger-1", node: "merge:join", revision: 1, attempt: 1, sessionId: "merger-1",
      worktree: "/worktrees/join", before: "base", after: null, status: "completed", output: "", startedAt: 1, completedAt: 2 }],
  };
  const failedMergerState = {
    ...mergerState,
    mergers: [{ ...mergerState.mergers[0], id: "merger-failed", status: "failed" }],
  };
  const publicationMergerState = {
    ...mergerState,
    plan: { executionBatches: [["join"]], roots: ["join"], terminals: ["join"], warnings: [] },
    mergers: [{ ...mergerState.mergers[0], id: "publish-merger", node: "merger", status: "completed" }],
  };
  const runningMergerState = {
    ...mergerState,
    mergers: [{ ...mergerState.mergers[0], id: "merger-running", status: "running", completedAt: null }],
  };
  const cases = [
    ["layout/Sidebar", "Sidebar", { projects: [], activeRepo: "", runs: [], currentRunId: "", runIndicators: {}, onSelectProject: noop, onOpenProject: noop, onRemoveProject: noop, onLoadRun: noop, onDeleteRun: noop, onNewConversation: noop, onOpenSettings: noop }],
    ["modals/SettingsModal", "SettingsModal", { isOpen: true, config, setConfig: noop, dataPath: "", onClose: noop, onSaveConfig: noop }],
    ["ExtensionSettings", "ExtensionItem", { extension: { id: "probe.ts", name: "probe", source: "auto", path: "probe.ts", enabled: true, required: false, bundled: false }, disabled: false, onToggle: noop }],
    ["modals/ApprovalModal", "ApprovalModal", { isOpen: true, state, config, onClose: noop, onAdjustPlan: noop, onApprove: noop }],
    ["modals/EditorModal", "EditorModal", { isOpen: true, initialGraph: example, onClose: noop, onSave: noop, onError: noop }],
    ["modals/ConfirmModal", "ConfirmModal", { config: { title: t("删除历史"), message: t("确定清空当前工作区的所有历史运行记录吗？"), confirmText: t("清空全部"), onConfirm: noop }, onClose: noop }],
    ["views/LandingView", "LandingView", { goal: "", setGoal: noop, onPlanGoal: noop }],
    ["ThinkingCard", "ThinkingCard", { content: "", isStreaming: true }],
    ["ThinkingCard", "ThinkingCard", { content: "Inspect:\n\n```sh\necho hello\n```", isStreaming: false }],
    ["views/NodeTaskCard", "NodeTaskCard", { nodeName: "worker", taskText: "Inspect:\n\n```sh\necho hello\n```", editing: false, draft: "", onDraftChange: noop, onEdit: noop, onCancel: noop, onSave: noop }],
    ["graph/TaskNode", "TaskNode", { data: { name: "review", task: "Review result", status: "completed", attempts: 4, hint: "", reviewer: true, selected: false, worktree: "", feedbackExhaustion: { from: "review", to: "owner", count: 3, limit: 3 } } }],
    ["ToolCallCard", "ToolCallCard", { item: { id: "tool", type: "tool_call", toolName: "bash", status: "running", args: {} } }],
    ["PublicationCompletedDetails", "PublicationCompletedDetails", { state: { ...state, phase: "completed" } }],
    ["views/GraphWorkbench", "GraphWorkbench", { state, activity: [{ kind: "workspace_prepare", nodes: ["foundation_contract"] }], routeType: "graph", selected: "", setSelected: noop, selectedMergerId: "", setSelectedMergerId: noop, effectiveMessages: [], plannerStream: {}, isPlanning: false, onSendMessage: noop, onRequestConfirmation: noop, onControl: noop, onSave: noop, onOpenEditor: noop, onOpenApproval: noop, onOpenFile: noop, onPickRepository: noop, onDetectRepository: noop, repoInfo: null, config, goal: "", nodes: [], edges: [], nodeTypes: {}, edgeTypes: {}, tokens: {} }],
    ["views/GraphWorkbench", "GraphWorkbench", { state: mergerState, routeType: "graph", selected: "join", setSelected: noop, selectedMergerId: "merger-1", setSelectedMergerId: noop, effectiveMessages: [], plannerStream: {}, isPlanning: false, onSendMessage: noop, onRequestConfirmation: noop, onControl: noop, onSave: noop, onOpenEditor: noop, onOpenApproval: noop, onOpenFile: noop, onPickRepository: noop, onDetectRepository: noop, repoInfo: null, config, goal: "", nodes: [], edges: [], nodeTypes: {}, edgeTypes: {}, tokens: {} }],
    ["views/GraphWorkbench", "GraphWorkbench", { state: failedMergerState, routeType: "graph", selected: "join", setSelected: noop, selectedMergerId: "merger-failed", setSelectedMergerId: noop, effectiveMessages: [], plannerStream: {}, isPlanning: false, onSendMessage: noop, onRequestConfirmation: noop, onControl: noop, onSave: noop, onOpenEditor: noop, onOpenApproval: noop, onOpenFile: noop, onPickRepository: noop, onDetectRepository: noop, repoInfo: null, config, goal: "", nodes: [], edges: [], nodeTypes: {}, edgeTypes: {}, tokens: {} }],
    ["views/GraphWorkbench", "GraphWorkbench", { state: publicationMergerState, routeType: "graph", selected: "merger:publication", setSelected: noop, selectedMergerId: "publish-merger", setSelectedMergerId: noop, effectiveMessages: [], plannerStream: {}, isPlanning: false, onSendMessage: noop, onRequestConfirmation: noop, onControl: noop, onSave: noop, onOpenEditor: noop, onOpenApproval: noop, onOpenFile: noop, onPickRepository: noop, onDetectRepository: noop, repoInfo: null, config, goal: "", nodes: [], edges: [], nodeTypes: {}, edgeTypes: {}, tokens: {} }],
    ["views/GraphWorkbench", "GraphWorkbench", { state: runningMergerState, routeType: "graph", selected: "join", setSelected: noop, selectedMergerId: "merger-running", setSelectedMergerId: noop, effectiveMessages: [], plannerStream: {}, isPlanning: false, onSendMessage: noop, onRequestConfirmation: noop, onControl: noop, onSave: noop, onOpenEditor: noop, onOpenApproval: noop, onOpenFile: noop, onPickRepository: noop, onDetectRepository: noop, repoInfo: null, config, goal: "", nodes: [], edges: [], nodeTypes: {}, edgeTypes: {}, tokens: {} }],
  ];
  for (const [path, name, props] of cases) {
    const module = await vite.ssrLoadModule(`/src/components/${path}.tsx`);
    const element = React.createElement(module[name], props);
    const html = renderToStaticMarkup(name === "TaskNode" ? taskNodeCanvas(module[name], props.data) : element);
    assert.ok(html.length > 0, `${name} must render`);
    if (locale === "en") assert.doesNotMatch(html, /\p{Script=Han}/u, `${name} has untranslated UI copy`);
    if (name === "SettingsModal") {
      assert.ok(html.includes("Settings"));
      assert.ok(html.includes(`>${locale === "en" ? "Provider configuration" : "Provider配置"}</h4>`));
      assert.ok(html.includes(`>${locale === "en" ? "Model configuration" : "模型配置"}</h4>`));
      assert.ok(html.includes(`>${locale === "en" ? "Harness settings" : "Harness设置"}</h4>`));
      assert.ok(html.includes(`>${locale === "en" ? "UI settings" : "UI设置"}</h4>`));
      assert.ok(html.includes(t("界面语言")));
      assert.ok(html.includes(`value="${preference}" selected=""`));
      assert.ok(!html.includes('role="alertdialog"'), "confirmation is not shown before a language change");
    }
    if (name === "ExtensionItem") {
      assert.ok(html.includes(`>${locale === "en" ? "Remove" : "移除"}</button>`), "enabled extensions offer removal, not deletion");
      assert.ok(html.includes(`aria-label="${t('{0}扩展 {1}', t('移除'), 'probe')}"`));
    }
    if (name === "ApprovalModal") {
      // Verify the rendered disclosure, not a particular translation call or sentence.
      const copy = html.replace(/<[^>]*>/g, " ");
      assert.match(copy, locale === "en" ? /private source snapshot/i : /私有源快照/);
      assert.match(copy, locale === "en" ? /does not stage, commit, move your branch, or replace your index/i : /不会暂存、提交或移动你的分支与索引/);
      assert.match(copy, locale === "en" ? /without creating a commit/i : /不创建提交/);
      assert.match(copy, locale === "en" ? /Git\/Grapher internals are excluded/i : /Git\/Grapher 内部文件除外/);
    }
    if (name === "Sidebar") assert.ok(html.includes(t("暂无工作区")));
    if (name === "GraphWorkbench") {
      if (props.activity) {
        for (const [phase, label] of [
          [undefined, "正在准备节点工作区"], // Resumes and mixed concurrent stages have no phase.
          ["verify", "正在准备节点工作区"],
          ["unknown", "正在准备节点工作区"],
          ["copy", "正在复制节点工作区"],
          ["compose", "正在准备节点工作区（合并上游结果）"],
          ["conflict", "正在准备节点工作区（解决合并冲突）"],
        ]) {
          for (const nodes of [[], ["unique_workspace_one"], ["unique_workspace_one", "unique_workspace_two"]]) {
            const statusHtml = renderToStaticMarkup(React.createElement(module[name], {
              ...props, activity: [{ kind: "workspace_prepare", phase, nodes }],
            }));
            assert.ok(statusHtml.includes(t(label)), "activity status must render localized phase copy");
            assert.equal(statusHtml.includes(t("正在复制节点工作区")), phase === "copy",
              "only an explicit copy phase may claim that workspaces are being copied");
            assert.ok(!statusHtml.includes("unique_workspace_"), "activity status must not list node names");
            assert.doesNotMatch(statusHtml, /\(1\s*\/\s*1\)/, "a single workspace must not show progress");
          }
        }
      }
      if (props.selectedMergerId) {
        assert.ok(html.includes(t("merger · {0}", "join")) || html.includes(t("publication merger")), "merger card heading must render localized copy");
        if (props.selectedMergerId === "merger-running") {
          assert.ok(html.includes('placeholder="Steer..."'), "a live merger composer is labeled Steer");
        } else if (props.selectedMergerId === "merger-failed" || props.selected === "merger:publication") {
          assert.ok(html.includes('placeholder="Type..."'), "a continuable idle merger composer invites typing");
        } else {
          assert.ok(!html.includes('placeholder="Type..."') && !html.includes("Steer..."),
            "a disabled merger composer keeps an empty placeholder");
        }
      }
    }
    if (name === "TaskNode") {
      assert.doesNotMatch(html, /\stitle=/, "nodes and feedback warnings must not show native hover tooltips");
      assert.ok(html.includes(">Completed</span>"));
      assert.ok(html.includes(t("反馈预算耗尽 {0}/{1}", 3, 3)));
      assert.ok(html.includes(t("反馈次数耗尽，本次反馈未应用；未向 {0} 反馈，后续节点继续执行。", "owner")));
      const plain = renderToStaticMarkup(taskNodeCanvas(module[name], { ...props.data, feedbackExhaustion: undefined }));
      assert.doesNotMatch(plain, /\stitle=/, "plain nodes must not show native hover tooltips");
    }
    if (name === "ToolCallCard" || name === "ThinkingCard" || name === "NodeTaskCard") {
      assert.doesNotMatch(html, /\stitle=/, `${name} must not show native hover tooltips`);
    }
  }
  assert.equal(locale, preference === "auto" ? (language.startsWith("zh") ? "zh-CN" : "en") : preference);
  assert.equal(t("Build Anything"), "Build Anything");

  // User content is not UI copy and must never be translated or stripped.
  const { EditableUserBubble } = await vite.ssrLoadModule("/src/components/views/ChatBubbles.tsx");
  const html = renderToStaticMarkup(React.createElement(EditableUserBubble, { text: "用户输入保持原样 {0}", editing: false, draft: "", onDraftChange: noop, onCancel: noop, onSend: noop }));
  assert.ok(html.includes("用户输入保持原样 {0}"));
  console.log(`UI smoke passed: ${language}`);
} finally {
  await vite.close();
}
