import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultConfig, type Config } from "../src/types.ts";
import { normalizeModelThinkingLevels, planningModelRoles, resolveExecutionModelAndThinking, roleModelConfig, updateRoleModelConfig } from "../src/modelConfig.ts";
import { RoleModelSettings } from "../src/components/RoleModelSettings.tsx";
import type { ProviderCatalog } from "../src/services/providerAuth.ts";
import { t } from "../src/i18n/index.ts";
import type { Execution } from "../src/types.ts";

const catalog: ProviderCatalog = {
  providers: [
    { id: "example", name: "Ready Provider", methods: [], configured: true, authType: "api_key" },
    { id: "closed", name: "Unavailable Provider", methods: [], configured: false, authType: null },
  ],
  models: [
    { provider: "example", id: "default", name: "Ready Model", api: "test", contextWindow: 1000, available: true,
      thinkingLevels: ["off", "low", "high"], thinkingLevelFallbacks: { minimal: "low", medium: "high", xhigh: "high", max: "high" } },
    { provider: "example", id: "plain", name: "Plain Model", api: "test", contextWindow: 1000, available: true,
      thinkingLevels: ["off"], thinkingLevelFallbacks: { minimal: "off", low: "off", medium: "off", high: "off", xhigh: "off", max: "off" } },
    { provider: "example", id: "restricted", name: "Restricted Model", api: "test", contextWindow: 1000, available: true,
      thinkingLevels: ["low", "high", "max"], thinkingLevelFallbacks: { off: "low", minimal: "low", medium: "high", xhigh: "max" } },
    { provider: "example", id: "hidden", name: "Unavailable Model", api: "test", contextWindow: 1000, available: false },
    { provider: "closed", id: "old", name: "Old Model", api: "test", contextWindow: 1000, available: false },
  ],
  warning: null,
};

const legacy: Config = { ...defaultConfig, model: "example/default", thinkingLevel: "high" };

test("legacy settings inherit models but Partitioner defaults to thinking low", () => {
  assert.deepEqual(roleModelConfig(legacy, "partitioner"), { model: "example/default", thinkingLevel: "low" });
  assert.deepEqual(roleModelConfig(legacy, "planner"), { model: "example/default", thinkingLevel: "high" });
  assert.deepEqual(roleModelConfig(legacy, "nodeAgent"), { model: "example/default", thinkingLevel: "high" });
});

test("role selections and thinking levels update independently and round-trip", () => {
  let config = updateRoleModelConfig(legacy, "partitioner", { model: "example/small", thinkingLevel: "off" });
  config = updateRoleModelConfig(config, "planner", { model: "example/large", thinkingLevel: "max" });
  config = updateRoleModelConfig(config, "nodeAgent", { model: "example/coder", thinkingLevel: "low" });
  config = JSON.parse(JSON.stringify(config));
  assert.equal(config.model, "example/coder");
  assert.equal(config.thinkingLevel, "low");
  assert.deepEqual(roleModelConfig(config, "partitioner"), { model: "example/small", thinkingLevel: "off" });
  assert.deepEqual(roleModelConfig(config, "planner"), { model: "example/large", thinkingLevel: "max" });
  assert.deepEqual(roleModelConfig(config, "nodeAgent"), { model: "example/coder", thinkingLevel: "low" });
  assert.equal(legacy.roleModels, undefined);
});

test("thinking-only customization keeps model inheritance; environment has precedence", () => {
  let config = updateRoleModelConfig(legacy, "planner", { thinkingLevel: "medium" });
  assert.deepEqual(roleModelConfig(config, "planner"), { model: "example/default", thinkingLevel: "medium" });
  config = updateRoleModelConfig(config, "partitioner", { thinkingLevel: "high" });
  assert.equal(roleModelConfig(config, "partitioner").thinkingLevel, "high");
  assert.deepEqual(roleModelConfig(config, "planner", { planner: "env/model", plannerThinking: "off" }), { model: "env/model", thinkingLevel: "off" });
});

test("preflight uses only the roles required for the selected mode", () => {
  assert.deepEqual(planningModelRoles("serial"), ["nodeAgent"]);
  assert.deepEqual(planningModelRoles("graph"), ["planner", "nodeAgent"]);
  assert.deepEqual(planningModelRoles("auto"), ["partitioner", "planner", "nodeAgent"]);
});

test("role selectors offer only available models and their providers, without free-text entry", () => {
  const markup = renderToStaticMarkup(React.createElement(RoleModelSettings, { config: legacy, setConfig: () => {}, catalog, busy: false }));
  assert.equal((markup.match(/value="example\/default"/g) ?? []).length, 3);
  assert.ok(!markup.includes("example/hidden"));
  assert.ok(!markup.includes("closed/old"));
  assert.ok(!markup.includes("Unavailable Provider"));
  assert.ok(!markup.includes("<input"));
  assert.ok(!markup.includes("<datalist"));
});

test("an unavailable saved model is preserved as a disabled option with a warning", () => {
  const config = updateRoleModelConfig(legacy, "planner", { model: "closed/old" });
  const markup = renderToStaticMarkup(React.createElement(RoleModelSettings, { config, setConfig: () => {}, catalog, busy: false }));
  assert.match(markup, /<option[^>]*value="closed\/old"[^>]*disabled=""/);
  assert.ok(markup.includes(t("当前使用的模型不可用，请先认证对应 Provider 或重新选择可用模型。")));
  assert.equal(config.roleModels?.planner?.model, "closed/old");
});

test("missing and empty catalogs guide the user to authentication instead of showing all models", () => {
  const render = (catalog?: ProviderCatalog, busy = false) => renderToStaticMarkup(React.createElement(RoleModelSettings, { config: legacy, setConfig: () => {}, catalog, busy }));
  assert.ok(render(undefined, true).includes(t("正在加载可用模型…")));
  assert.ok(render().includes(t("模型列表暂不可用，请在上方刷新 Provider 状态。")));
  const empty = { ...catalog, models: catalog.models.map(model => ({ ...model, available: false })) };
  assert.ok(render(empty).includes(t("暂无可用模型，请先在上方登录 Provider 或绑定 API Key，然后刷新状态。")));
  assert.ok(!render(empty).includes("example/hidden"));
});

test("credential catalog updates remove and restore choices without changing saved role settings", () => {
  const config = updateRoleModelConfig(legacy, "planner", { model: "example/default", thinkingLevel: "low" });
  const render = (catalog: ProviderCatalog) => renderToStaticMarkup(React.createElement(RoleModelSettings, { config, setConfig: () => {}, catalog, busy: false }));
  const loggedOut = { ...catalog, models: catalog.models.map(model => ({ ...model, available: false })) };
  assert.ok(render(loggedOut).includes(`${t("已选模型不可用：")}example/default`));
  assert.ok(!render(catalog).includes(t("已选模型不可用：")));
  assert.deepEqual(config.roleModels?.planner, { model: "example/default", thinkingLevel: "low" });
});

function renderRoles(config: Config, models: ProviderCatalog | undefined, envOverrides = {}, busy = false) {
  const markup = renderToStaticMarkup(React.createElement(RoleModelSettings, { config, setConfig: () => {}, catalog: models, envOverrides, busy }));
  return [...markup.matchAll(/<section class="role-model-card"[\s\S]*?<\/section>/g)].map(([card]) => {
    const select = [...card.matchAll(/<select\b[\s\S]*?<\/select>/g)][1][0];
    return { card, select, values: [...select.matchAll(/<option[^>]*value="([^"]*)"/g)].map(match => match[1]) };
  });
}

test("thinking selectors use per-model Pi capabilities, including inherited models and Partitioner without off", () => {
  const [partitioner, planner, node] = renderRoles(legacy, catalog);
  for (const field of [partitioner, planner, node]) assert.deepEqual(field.values, ["off", "low", "high"]);
  const config = updateRoleModelConfig(legacy, "nodeAgent", { model: "example/restricted", thinkingLevel: "xhigh" });
  const roles = renderRoles(config, catalog);
  for (const field of roles) assert.deepEqual(field.values, ["low", "high", "max"]);
  assert.match(roles[0].select, /value="low" selected=""/);
  assert.match(roles[1].select, /value="max" selected=""/);
  assert.match(roles[2].select, /value="max" selected=""/);
  assert.equal(config.thinkingLevel, "xhigh", "rendering must not mutate persisted settings");
});

test("single-level models have a disabled selector and preserve the intent of separately configured roles", () => {
  const config = updateRoleModelConfig({ ...legacy, model: "example/plain" }, "planner", { model: "example/restricted" });
  const normalized = normalizeModelThinkingLevels(config, catalog);
  assert.equal(normalized.thinkingLevel, "off");
  assert.equal(normalized.roleModels?.nodeAgent?.thinkingLevel, "off");
  assert.equal(roleModelConfig(normalized, "planner").thinkingLevel, "high");
  assert.equal(normalized.roleModels?.planner?.model, "example/restricted");
  assert.equal(config.thinkingLevel, "high");
  assert.equal(config.roleModels?.planner?.thinkingLevel, "high");
  assert.equal(normalizeModelThinkingLevels(normalized, catalog), normalized, "normalization is idempotent");
  const [partitioner, planner, node] = renderRoles(config, catalog);
  for (const field of [partitioner, node]) {
    assert.deepEqual(field.values, ["off"]);
    assert.match(field.select, /<select[^>]*disabled=""/);
    assert.match(field.select, /value="off" selected=""/);
  }
  assert.doesNotMatch(planner.select, /<select[^>]*disabled=""/);
});

test("a fixed reasoning level stays enabled in Pi but is not adjustable; full-capability models still offer all levels", () => {
  const fixed: ProviderCatalog = { ...catalog, models: catalog.models.map(model => model.id === "default"
    ? { ...model, thinkingLevels: ["high"], thinkingLevelFallbacks: { off: "high", low: "high" } } : model) };
  for (const field of renderRoles(legacy, fixed)) {
    assert.deepEqual(field.values, ["high"]);
    assert.match(field.select, /<select[^>]*disabled=""/);
    assert.match(field.select, /value="high" selected=""/);
  }
  const all = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
  const extended: ProviderCatalog = { ...catalog, models: catalog.models.map(model => ({ ...model, thinkingLevels: [...all], thinkingLevelFallbacks: {} })) };
  for (const field of renderRoles(legacy, extended)) assert.deepEqual(field.values, all);
});

test("normalizing Node Agent preserves an unknown model's inherited thinking intent", () => {
  const config: Config = { ...legacy, model: "example/plain", roleModels: { planner: { model: "closed/old" } } };
  const normalized = normalizeModelThinkingLevels(config, catalog);
  assert.equal(normalized.thinkingLevel, "off");
  assert.deepEqual(normalized.roleModels?.planner, { model: "closed/old", thinkingLevel: "high" });
  assert.equal(config.roleModels?.planner?.thinkingLevel, undefined);
});

test("unknown capabilities disable controls and never invent seven choices or overwrite saved values", () => {
  for (const models of [undefined, { ...catalog, models: catalog.models.map(({ thinkingLevels, thinkingLevelFallbacks, ...model }) => model) }]) {
    assert.equal(normalizeModelThinkingLevels(legacy, models), legacy);
    for (const field of renderRoles(legacy, models)) {
      assert.equal(field.values.length, 1);
      assert.match(field.select, /<select[^>]*disabled=""/);
      assert.match(field.select, /<option[^>]*disabled=""/);
      assert.ok(field.card.includes(t("暂未获取该模型的思维等级，请刷新 Provider 状态。")));
    }
  }
  const unavailable = updateRoleModelConfig(legacy, "planner", { model: "closed/old", thinkingLevel: "max" });
  assert.equal(normalizeModelThinkingLevels(unavailable, catalog), unavailable);
});

test("capability refreshes and model switches use backend fallbacks rather than a frontend level heuristic", () => {
  const refreshed: ProviderCatalog = { ...catalog, models: catalog.models.map(model => model.id === "default"
    ? { ...model, thinkingLevels: ["minimal", "max"], thinkingLevelFallbacks: { low: "max", off: "max", high: "max" } } : model) };
  const normalized = normalizeModelThinkingLevels(legacy, refreshed);
  assert.equal(roleModelConfig(normalized, "partitioner").thinkingLevel, "max", "the backend fallback is authoritative even if minimal is first");
  assert.equal(roleModelConfig(normalized, "planner").thinkingLevel, "max");
  assert.equal(normalized.thinkingLevel, "max");
  const switched = normalizeModelThinkingLevels(updateRoleModelConfig(normalized, "nodeAgent", { model: "example/plain" }), catalog);
  for (const role of ["partitioner", "planner", "nodeAgent"] as const) assert.equal(roleModelConfig(switched, role).thinkingLevel, "off");
});

test("environment overrides stay visible without changing the saved model's supported choices", () => {
  const [partitioner] = renderRoles(legacy, catalog, { partitioner: "example/plain", partitionerThinking: "off" });
  assert.deepEqual(partitioner.values, ["off", "low", "high"]);
  assert.ok(partitioner.card.includes(`${t("环境变量覆盖：")}example/plain · off`));
  for (const field of renderRoles(legacy, catalog, {}, true)) assert.match(field.select, /<select[^>]*disabled=""/);
});

test('only required pi-trim is locked; bundled continuity and user extensions remain selectable', async () => {
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: false, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
  });
  try {
    const { ExtensionItem } = await vite.ssrLoadModule('/src/components/ExtensionSettings.tsx');
    const render = (bundled: boolean, enabled = true, required = bundled) => renderToStaticMarkup(React.createElement(ExtensionItem, {
      extension: { id: bundled ? (required ? 'npm:pi-trim' : 'npm:pi-continuity') : 'probe.ts',
        name: bundled ? (required ? 'pi-trim' : 'pi-continuity') : 'probe', bundled, required, enabled, path: 'probe.ts', source: 'auto' },
      disabled: false, onToggle() {},
    }));
    const required = render(true);
    assert.ok(!required.includes('<button'));
    assert.match(required, /role="img"/);
    assert.ok(required.includes(t('始终启用，不可删除')));
    assert.ok(render(false).includes(t('{0}扩展 {1}', t('删除'), 'probe')));
    assert.ok(render(false, false).includes(t('{0}扩展 {1}', t('添加'), 'probe')));
    assert.ok(render(true, true, false).includes(t('{0}扩展 {1}', t('删除'), 'pi-continuity')));
    assert.ok(render(true, false, false).includes(t('{0}扩展 {1}', t('添加'), 'pi-continuity')));
    assert.ok(!render(true, true, false).includes(t('始终启用，不可删除')));
    for (const enabled of [true, false]) {
      const path = '/Users/jerry/.pi/agent/npm/node_modules/pi-continuity/extensions/index.ts';
      const markup = renderToStaticMarkup(React.createElement(ExtensionItem, {
        extension: { id: 'npm:pi-continuity', name: 'pi-continuity', source: 'npm:pi-continuity',
          path, bundled: true, required: false, enabled },
        disabled: false, onToggle() {},
      }));
      assert.ok(!markup.includes(path), 'bundled continuity describes its purpose instead of exposing a local path');
      assert.ok(markup.includes(t('{0}扩展 {1}', enabled ? t('删除') : t('添加'), 'pi-continuity')));
    }
  } finally { await vite.close(); }
});

test('Auto Approve defaults to off, including legacy configs; only an explicit saved true enables it', async () => {
  assert.equal(defaultConfig.autoApprove, false);
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: false, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
  });
  try {
    const { SettingsModal } = await vite.ssrLoadModule('/src/components/modals/SettingsModal.tsx');
    const checkbox = (config: Config) => {
      const markup = renderToStaticMarkup(React.createElement(SettingsModal, {
        isOpen: true, onClose() {}, config, dataPath: '', onSaveConfig() {},
      }));
      const input = markup.match(/<input\b[^>]*>/g)?.find(input => input.includes(`aria-label="${t('Auto Approve Planner 图纸')}"`));
      assert.ok(input, 'Auto Approve checkbox is present');
      return input;
    };
    assert.doesNotMatch(checkbox(defaultConfig), /checked=""/);
    const oldConfig: Partial<Config> = { ...defaultConfig };
    delete oldConfig.autoApprove;
    assert.doesNotMatch(checkbox(oldConfig as Config), /checked=""/);
    assert.match(checkbox({ ...defaultConfig, autoApprove: true }), /checked=""/);
  } finally { await vite.close(); }
});

test("ProviderAuthAdapter passes device ID to runtime login options", async () => {
  const { ProviderAuthAdapter } = await import("../engine/provider-auth-adapter.mjs");
  let capturedOptions: unknown;
  const mockRuntime = {
    getProviders: () => [
      { id: "openai", auth: { oauth: { login: async () => {} } } },
    ],
    login: async (_provider: string, _method: string, _interaction: unknown, options: unknown) => {
      capturedOptions = options;
    },
  };
  const adapter = new ProviderAuthAdapter(
    () => Promise.resolve(mockRuntime as never),
    { getDeviceId: () => "mock-device-id-1234" }
  );

  const job = await adapter.start("openai", "oauth");
  assert.equal(job.provider, "openai");
  assert.equal(job.status, "pending");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(capturedOptions, "options were passed to runtime.login");
  assert.equal((capturedOptions as { getDeviceId: () => string }).getDeviceId(), "mock-device-id-1234");
});

test("resolveExecutionModelAndThinking extracts model and thinking from execution output events", () => {
  const execution: Execution = {
    id: "exec-1",
    node: "task-1",
    revision: 1,
    attempt: 1,
    sessionId: "sess-1",
    worktree: "/path/to/worktree",
    before: "abc1234",
    after: "def5678",
    status: "done",
    output: [
      JSON.stringify({ type: "session", id: "sess-1" }),
      JSON.stringify({ type: "model_change", provider: "openai-codex", modelId: "gpt-6-sol" }),
      JSON.stringify({ type: "thinking_level_change", thinkingLevel: "high" }),
    ].join("\n"),
    startedAt: 1000,
    completedAt: 2000,
  };

  const result = resolveExecutionModelAndThinking(execution, false, legacy, {});
  assert.equal(result.model, "openai-codex/gpt-6-sol");
  assert.equal(result.thinkingLevel, "high");
});

test("failed-node model overrides provide the next attempt's fallback without rewriting recorded model events", () => {
  const execution: Execution = {
    id: "retry", node: "task", revision: 1, attempt: 2, sessionId: "same-session", worktree: "/worktree",
    before: "base", after: null, status: "running", output: "", startedAt: 1000, completedAt: null,
  };
  const replacement = { model: "replacement/coder", thinkingLevel: "high" as const };
  assert.deepEqual(resolveExecutionModelAndThinking(execution, false, legacy, {}, replacement), replacement);
  assert.deepEqual(resolveExecutionModelAndThinking(execution, false, legacy, {
    nodeAgent: "env/model", nodeAgentThinking: "off",
  }, replacement), { model: "env/model", thinkingLevel: "off" });
  assert.equal(resolveExecutionModelAndThinking(execution, true, legacy, {}, replacement).model, legacy.model);
  execution.output = JSON.stringify({ type: "model_change", provider: "recorded", modelId: "original" });
  assert.equal(resolveExecutionModelAndThinking(execution, false, legacy, {}, replacement).model, "recorded/original");
});

test("resolveExecutionModelAndThinking falls back to config and role models when not in output", () => {
  const execution: Execution = {
    id: "exec-2",
    node: "task-2",
    revision: 1,
    attempt: 1,
    sessionId: "sess-2",
    worktree: "/path/to/worktree-2",
    before: "1111111",
    after: "2222222",
    status: "done",
    output: "some regular non-json text\n",
    startedAt: 1000,
    completedAt: 2000,
  };

  const customConfig: Config = {
    ...defaultConfig,
    model: "fallback/base",
    thinkingLevel: "medium",
    roleModels: {
      nodeAgent: { model: "custom/agent", thinkingLevel: "low" },
    },
  };

  // Node agent role
  const nodeResult = resolveExecutionModelAndThinking(execution, false, customConfig, {});
  assert.equal(nodeResult.model, "custom/agent");
  assert.equal(nodeResult.thinkingLevel, "low");

  // Merger role with env override
  const mergerResult = resolveExecutionModelAndThinking(execution, true, customConfig, {
    merger: "env/merger-model",
    mergerThinking: "xhigh",
  });
  assert.equal(mergerResult.model, "env/merger-model");
  assert.equal(mergerResult.thinkingLevel, "xhigh");
});

