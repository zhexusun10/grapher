import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultConfig, type Config } from "../src/types.ts";
import { planningModelRoles, roleModelConfig, updateRoleModelConfig } from "../src/modelConfig.ts";
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
