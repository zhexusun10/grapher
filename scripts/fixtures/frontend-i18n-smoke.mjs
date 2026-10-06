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
  const state = { ...emptySnapshot, graph: example, config, runId: "run-123", phase: "awaiting_approval" };
  const planning = { planningId: "plan-123", roles: {}, totalPlanningDuration: 65, modelDuration: 61, status: "failed", error: "用户已停止本次执行；可以修改消息或重新运行。" };
  const cases = [
    ["layout/Sidebar", "Sidebar", { projects: [], activeRepo: "", runs: [], currentRunId: "", runIndicators: {}, onSelectProject: noop, onOpenProject: noop, onRemoveProject: noop, onLoadRun: noop, onDeleteRun: noop, onNewConversation: noop, onOpenSettings: noop }],
    ["modals/SettingsModal", "SettingsModal", { isOpen: true, config, setConfig: noop, dataPath: "", onClose: noop, onSaveConfig: noop }],
    ["modals/ApprovalModal", "ApprovalModal", { isOpen: true, state, config, onClose: noop, onAdjustPlan: noop, onApprove: noop }],
    ["modals/EditorModal", "EditorModal", { isOpen: true, initialGraph: example, onClose: noop, onSave: noop, onError: noop }],
    ["modals/ConfirmModal", "ConfirmModal", { config: { title: t("删除历史"), message: t("确定清空当前工作区的所有历史运行记录吗？"), confirmText: t("清空全部"), onConfirm: noop }, onClose: noop }],
    ["views/LandingView", "LandingView", { goal: "", setGoal: noop, onPlanGoal: noop }],
    ["PlanningSummaryCard", "PlanningSummaryCard", { planning, state, defaultExpanded: true }],
    ["ThinkingCard", "ThinkingCard", { content: "", isStreaming: true }],
    ["graph/TaskNode", "TaskNode", { data: { name: "review", task: "Review result", status: "done", attempts: 4, hint: "", reviewer: true, selected: false, worktree: "", feedbackExhaustion: { from: "review", to: "owner", count: 3, limit: 3 } } }],
    ["ToolCallCard", "ToolCallCard", { item: { id: "tool", type: "tool_call", toolName: "bash", status: "running", args: {} } }],
    ["PublicationPanel", "PublicationPanel", { publication: { repository: "/project", heads: ["abc"], status: "failed", error: planning.error, head: null }, mergers: [], onRetry: noop }],
    ["PublicationCompletedCard", "PublicationCompletedCard", { state: { ...state, phase: "completed" }, routeType: "graph" }],
    ["views/GraphWorkbench", "GraphWorkbench", { state, routeType: "graph", selected: "", setSelected: noop, effectiveMessages: [], plannerStream: {}, isPlanning: false, onSendMessage: noop, onRequestConfirmation: noop, onControl: noop, onSave: noop, onOpenEditor: noop, onOpenApproval: noop, onPickRepository: noop, onDetectRepository: noop, repoInfo: null, config, goal: "", nodes: [], edges: [], nodeTypes: {}, edgeTypes: {}, tokens: {} }],
  ];
  for (const [path, name, props] of cases) {
    const module = await vite.ssrLoadModule(`/src/components/${path}.tsx`);
    const element = React.createElement(module[name], props);
    const html = renderToStaticMarkup(name === "TaskNode" ? taskNodeCanvas(module[name], props.data) : element);
    assert.ok(html.length > 0, `${name} must render`);
    if (locale === "en") assert.doesNotMatch(html, /\p{Script=Han}/u, `${name} has untranslated UI copy`);
    if (name === "SettingsModal") {
      assert.ok(html.includes(t("设置")));
      assert.ok(html.includes(t("界面语言")));
      assert.ok(html.includes(`value="${preference}" selected=""`));
      assert.match(html, /class="settings-cancel-btn"/);
      assert.match(html, /class="primary save-config-btn"[^>]*>[\s\S]*?width="18"/);
      assert.ok(!html.includes('role="alertdialog"'), "confirmation is not shown before a language change");
    }
    if (name === "Sidebar") assert.ok(html.includes(t("暂无工作区")));
    if (name === "TaskNode") {
      assert.match(html, /class="task-node[^\"]*done"/);
      assert.match(html, /class="status done"/);
      assert.ok(html.includes(t("反馈预算耗尽 {0}/{1}", 3, 3)));
      assert.ok(html.includes(t("反馈次数耗尽，本次反馈未应用；未向 {0} 反馈，后续节点继续执行。", "owner")));
      const plain = renderToStaticMarkup(taskNodeCanvas(module[name], { ...props.data, feedbackExhaustion: undefined }));
      assert.ok(!plain.includes("node-feedback-exhausted"));
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
