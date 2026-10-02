import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultConfig, type Config } from "../src/types.ts";
import { modelRoles, planningModelRoles, roleModelConfig, updateRoleModelConfig } from "../src/modelConfig.ts";
import { RoleModelSettings } from "../src/components/RoleModelSettings.tsx";
import type { ProviderCatalog } from "../src/services/providerAuth.ts";
import { t } from "../src/i18n/index.ts";

const catalog: ProviderCatalog = {
  providers: [
    { id: "example", name: "Ready Provider", methods: [], configured: true, authType: "api_key" },
    { id: "closed", name: "Unavailable Provider", methods: [], configured: false, authType: null },
  ],
  models: [
    { provider: "example", id: "default", name: "Ready Model", api: "test", contextWindow: 1000, available: true },
    { provider: "example", id: "hidden", name: "Unavailable Model", api: "test", contextWindow: 1000, available: false },
    { provider: "closed", id: "old", name: "Old Model", api: "test", contextWindow: 1000, available: false },
  ],
  warning: null,
};

const legacy: Config = { ...defaultConfig, model: "example/default", thinkingLevel: "high" };

test("legacy settings inherit models but Partitioner defaults to thinking off", () => {
  assert.deepEqual(roleModelConfig(legacy, "partitioner"), { model: "example/default", thinkingLevel: "off" });
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

test("settings expose three model and thinking selectors with recommendations", () => {
  const markup = renderToStaticMarkup(React.createElement(RoleModelSettings, { config: legacy, setConfig: () => {}, catalog, busy: false }));
  for (const role of modelRoles) {
    assert.ok(markup.includes(t("{0} 模型配置", role.label)));
    assert.ok(markup.includes(role.id === "nodeAgent" ? t("Pi Instance 思维等级") : `${role.label}${t(" 思维等级")}`));
  }
  assert.ok(markup.includes(modelRoles[0].description));
  assert.ok(markup.includes(modelRoles[1].description));
  assert.ok(markup.includes('value="off" selected=""'));
  assert.equal((markup.match(/class="role-model-card"/g) ?? []).length, 3);
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

test('required pi-trim has no remove/add button; user extensions remain selectable', async () => {
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: false, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
  });
  try {
    const { ExtensionItem } = await vite.ssrLoadModule('/src/components/ExtensionSettings.tsx');
    const render = (bundled: boolean, enabled = true) => renderToStaticMarkup(React.createElement(ExtensionItem, {
      extension: { id: bundled ? 'npm:pi-trim' : 'probe.ts', name: bundled ? 'pi-trim' : 'probe', bundled, enabled, path: 'probe.ts', source: 'auto' },
      disabled: false, onToggle() {},
    }));
    const required = render(true);
    assert.ok(!required.includes('<button'));
    assert.ok(!required.includes('<small'));
    assert.match(required, /role="img"/);
    assert.ok(required.includes(t('始终启用，不可删除')));
    assert.equal(required.replace(/<[^>]*>/g, ''), 'pi-trimauto', 'bundled extension shows no badge or lock text');
    assert.ok(render(false).includes(t('{0}扩展 {1}', t('删除'), 'probe')));
    assert.ok(render(false, false).includes(t('{0}扩展 {1}', t('添加'), 'probe')));
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

test("settings group Provider management and role configuration in separate sections", async () => {
  // Vite handles the auth component's CSS module during server-side rendering.
  const { createServer } = await import("vite");
  const vite = await createServer({
    configFile: false,
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
  });
  try {
    const { SettingsModal } = await vite.ssrLoadModule("/src/components/modals/SettingsModal.tsx");
    const markup = renderToStaticMarkup(React.createElement(SettingsModal, {
      isOpen: true, onClose() {}, config: legacy, setConfig() {}, dataPath: "", onSaveConfig() {},
    }));
    const extensionStart = markup.indexOf('aria-labelledby="extension-settings-title"');
    const languageStart = markup.indexOf('aria-labelledby="language-settings-title"');
    assert.ok(extensionStart >= 0 && languageStart > extensionStart, 'Extensions are the top Settings section');
    assert.ok(markup.includes(t('Pi 全局扩展')));
    assert.ok(markup.includes(t('删除仅在 Grapher 中停用，不卸载全局扩展；可从待选列表随时加回。')));
    assert.ok(!markup.includes('更改立即保存，对新启动的 Agent 生效。'));
    const providerStart = markup.indexOf('aria-labelledby="provider-settings-title"');
    const rolesStart = markup.indexOf('aria-labelledby="role-model-settings-title"');
    assert.ok(providerStart >= 0 && rolesStart > providerStart);
    const providers = markup.slice(providerStart, rolesStart);
    const roles = markup.slice(rolesStart);
    assert.ok(providers.includes(t("Provider 认证")));
    assert.ok(providers.includes(t("支持的 Provider 列表")));
    assert.ok(!providers.includes(t("{0} 模型配置", "Partitioner")));
    for (const role of modelRoles) assert.ok(roles.includes(t("{0} 模型配置", role.label)));
  } finally {
    await vite.close();
  }
});
