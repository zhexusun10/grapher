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
  const planning = { planningId: "plan-123", roles: {}, totalPlanningDuration: 65, modelDuration: 61, status: "failed", error: "用户已停止本次执行；可以修改消息或重新运行。" };
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
  const cases = [
    ["layout/Sidebar", "Sidebar", { projects: [], activeRepo: "", runs: [], currentRunId: "", runIndicators: {}, onSelectProject: noop, onOpenProject: noop, onRemoveProject: noop, onLoadRun: noop, onDeleteRun: noop, onNewConversation: noop, onOpenSettings: noop }],
    ["modals/SettingsModal", "SettingsModal", { isOpen: true, config, setConfig: noop, dataPath: "", onClose: noop, onSaveConfig: noop }],
    ["modals/ApprovalModal", "ApprovalModal", { isOpen: true, state, config, onClose: noop, onAdjustPlan: noop, onApprove: noop }],
    ["modals/EditorModal", "EditorModal", { isOpen: true, initialGraph: example, onClose: noop, onSave: noop, onError: noop }],
    ["modals/ConfirmModal", "ConfirmModal", { config: { title: t("删除历史"), message: t("确定清空当前工作区的所有历史运行记录吗？"), confirmText: t("清空全部"), onConfirm: noop }, onClose: noop }],
    ["views/LandingView", "LandingView", { goal: "", setGoal: noop, onPlanGoal: noop }],
    ["ThinkingCard", "ThinkingCard", { content: "", isStreaming: true }],
    ["graph/TaskNode", "TaskNode", { data: { name: "review", task: "Review result", status: "completed", attempts: 4, hint: "", reviewer: true, selected: false, worktree: "", feedbackExhaustion: { from: "review", to: "owner", count: 3, limit: 3 } } }],
    ["ToolCallCard", "ToolCallCard", { item: { id: "tool", type: "tool_call", toolName: "bash", status: "running", args: {} } }],
    ["PublicationPanel", "PublicationPanel", { publication: { repository: "/project", heads: ["abc"], status: "failed", error: planning.error, head: null }, mergers: [], onRetry: noop }],
    ["PublicationCompletedCard", "PublicationCompletedCard", { state: { ...state, phase: "completed" }, routeType: "graph" }],
    ["views/GraphWorkbench", "GraphWorkbench", { state, activity: [{ kind: "workspace_prepare", nodes: ["foundation_contract"] }], routeType: "graph", selected: "", setSelected: noop, selectedMergerId: "", setSelectedMergerId: noop, effectiveMessages: [], plannerStream: {}, isPlanning: false, onSendMessage: noop, onRequestConfirmation: noop, onControl: noop, onSave: noop, onOpenEditor: noop, onOpenApproval: noop, onPickRepository: noop, onDetectRepository: noop, repoInfo: null, config, goal: "", nodes: [], edges: [], nodeTypes: {}, edgeTypes: {}, tokens: {} }],
    ["views/GraphWorkbench", "GraphWorkbench", { state: mergerState, routeType: "graph", selected: "join", setSelected: noop, selectedMergerId: "merger-1", setSelectedMergerId: noop, effectiveMessages: [], plannerStream: {}, isPlanning: false, onSendMessage: noop, onRequestConfirmation: noop, onControl: noop, onSave: noop, onOpenEditor: noop, onOpenApproval: noop, onPickRepository: noop, onDetectRepository: noop, repoInfo: null, config, goal: "", nodes: [], edges: [], nodeTypes: {}, edgeTypes: {}, tokens: {} }],
    ["views/GraphWorkbench", "GraphWorkbench", { state: failedMergerState, routeType: "graph", selected: "join", setSelected: noop, selectedMergerId: "merger-failed", setSelectedMergerId: noop, effectiveMessages: [], plannerStream: {}, isPlanning: false, onSendMessage: noop, onRequestConfirmation: noop, onControl: noop, onSave: noop, onOpenEditor: noop, onOpenApproval: noop, onPickRepository: noop, onDetectRepository: noop, repoInfo: null, config, goal: "", nodes: [], edges: [], nodeTypes: {}, edgeTypes: {}, tokens: {} }],
    ["views/GraphWorkbench", "GraphWorkbench", { state: publicationMergerState, routeType: "graph", selected: "merger:publication", setSelected: noop, selectedMergerId: "publish-merger", setSelectedMergerId: noop, effectiveMessages: [], plannerStream: {}, isPlanning: false, onSendMessage: noop, onRequestConfirmation: noop, onControl: noop, onSave: noop, onOpenEditor: noop, onOpenApproval: noop, onPickRepository: noop, onDetectRepository: noop, repoInfo: null, config, goal: "", nodes: [], edges: [], nodeTypes: {}, edgeTypes: {}, tokens: {} }],
  ];
  for (const [path, name, props] of cases) {
    const module = await vite.ssrLoadModule(`/src/components/${path}.tsx`);
    const element = React.createElement(module[name], props);
    const html = renderToStaticMarkup(name === "TaskNode" ? taskNodeCanvas(module[name], props.data) : element);
    assert.ok(html.length > 0, `${name} must render`);
    if (locale === "en") assert.doesNotMatch(html, /\p{Script=Han}/u, `${name} has untranslated UI copy`);
    if (name === "SettingsModal") {
      assert.ok(html.includes("Settings"));
      assert.ok(html.includes(t("界面语言")));
      assert.ok(html.includes(`value="${preference}" selected=""`));
      assert.ok(!html.includes('role="alertdialog"'), "confirmation is not shown before a language change");
    }
    if (name === "ApprovalModal") {
      // Verify the rendered disclosure, not a particular translation call or sentence.
      const copy = html.replace(/<[^>]*>/g, " ");
      assert.match(copy, /\.gitignore/);
      assert.match(copy, locale === "en" ? /force-stag/i : /强制暂存/);
      assert.match(copy, locale === "en" ? /merged back/i : /合并回/);
      assert.match(copy, locale === "en" ? /managed environment scopes.*excluded/i : /受管环境范围除外/);
    }
    if (name === "Sidebar") assert.ok(html.includes(t("暂无工作区")));
    if (name === "GraphWorkbench") {
      if (props.activity) assert.ok(html.includes(t("正在复制节点工作区：{0}", "foundation_contract")), "activity status must render localized copy");
      if (props.selectedMergerId) {
        if (props.selected === "merger:publication") {
          assert.ok(html.includes(t("publication merger")), "publication merger heading must render");
          assert.ok(html.includes(t("向 publication merger 追加消息…")), "a settled publication merger still accepts follow-ups");
        } else if (props.selectedMergerId === "merger-failed") {
          assert.ok(html.includes(t("merger · {0}", "join")), "merger card heading must render localized copy");
          assert.ok(html.includes(t("向 merger 发送消息并重跑…")), "failed node merger allows sending message to re-run");
        } else {
          assert.ok(html.includes(t("merger · {0}", "join")), "merger card heading must render localized copy");
          assert.ok(html.includes(t("merger 已结束，只能查看执行记录")), "settled node merger must render the read-only notice");
        }
      }
    }
    if (name === "TaskNode") {
      assert.doesNotMatch(html, /\stitle=/, "nodes and feedback warnings must not show native hover tooltips");
      assert.ok(html.includes("COMPLETED"));
      assert.ok(html.includes(t("反馈预算耗尽 {0}/{1}", 3, 3)));
      assert.ok(html.includes(t("反馈次数耗尽，本次反馈未应用；未向 {0} 反馈，后续节点继续执行。", "owner")));
      const plain = renderToStaticMarkup(taskNodeCanvas(module[name], { ...props.data, feedbackExhaustion: undefined }));
      assert.doesNotMatch(plain, /\stitle=/, "plain nodes must not show native hover tooltips");
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
