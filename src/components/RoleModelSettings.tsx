import { t } from "../i18n";
import React, { useState } from "react";
import type { Config, ThinkingLevel } from "../types";
import type { ProviderCatalog } from "../services/providerAuth";
import { modelRoles, normalizeModelThinkingLevels, roleModelConfig, updateRoleModelConfig } from "../modelConfig";

const thinkingLabels: Record<ThinkingLevel, string> = {
  off: t("关闭"), minimal: t("最少 (minimal)"), low: t("低 (low)"),
  medium: t("中 (medium)"), high: t("高 (high)"), xhigh: t("极高 (xhigh)"), max: t("最大 (max)"),
};

export function RoleModelSettings({ config, setConfig, catalog, envOverrides = {}, busy }: {
  config: Config;
  setConfig: React.Dispatch<React.SetStateAction<Config>>;
  catalog?: ProviderCatalog;
  envOverrides?: Record<string, string>;
  busy: boolean;
}) {
  const [providerFilter, setProviderFilter] = useState("");
  const draft = normalizeModelThinkingLevels(config, catalog);
  const availableModels = catalog?.models.filter(model => model.available) ?? [];
  const availableProviders = catalog?.providers.filter(provider => availableModels.some(model => model.provider === provider.id)) ?? [];
  // A provider may disappear after logout. Don't leave a stale filter hiding
  // the remaining available models, or reset any role's persisted selection.
  const activeFilter = availableProviders.some(provider => provider.id === providerFilter) ? providerFilter : "";
  const models = availableModels.filter(model => !activeFilter || model.provider === activeFilter);

  return (
    <div className="role-model-settings">
      <p className="role-model-note">{t("三个角色分别配置模型与思维等级，仅可选择已可用的模型。Provider 认证由上方统一管理。")}</p>
      <p className="role-model-note">{t("思维等级由 Pi 按模型提供；不兼容的已保存等级会在保存时按 Pi 规则调整。")}</p>
      <label className="form-field">
        <span>{t("可用模型 Provider 筛选")}</span>
        <select value={activeFilter} disabled={busy || availableProviders.length === 0} onChange={event => setProviderFilter(event.target.value)} className="provider-filter-select">
          <option value="">{t("全部可用 Provider")}</option>
          {availableProviders.map(provider => <option key={provider.id} value={provider.id}>{provider.name} ({provider.id})</option>)}
        </select>
      </label>
      {!catalog && <p className="role-model-note" role="status">{busy ? t("正在加载可用模型…") : t("模型列表暂不可用，请在上方刷新 Provider 状态。")}</p>}
      {catalog && availableModels.length === 0 && <p className="role-model-note" role="status">{t("暂无可用模型，请先在上方登录 Provider 或绑定 API Key，然后刷新状态。")}</p>}
      {modelRoles.map(role => {
        const selected = draft.roleModels?.[role.id];
        const model = selected?.model ?? (role.id === "nodeAgent" ? draft.model : "");
        const settings = roleModelConfig(draft, role.id);
        const effective = roleModelConfig(draft, role.id, envOverrides);
        // Capabilities follow the saved/inherited model, not the provider filter
        // or an environment override that cannot be edited in this form.
        const thinkingModel = catalog?.models.find(item => `${item.provider}/${item.id}` === settings.model);
        const levels = thinkingModel?.thinkingLevels ?? [];
        const supported = levels.includes(settings.thinkingLevel);
        const override = envOverrides[role.id] || envOverrides[`${role.id}Thinking`];
        const currentModel = availableModels.find(item => `${item.provider}/${item.id}` === model);
        const unavailable = !!catalog && !!effective.model && !availableModels.some(item => `${item.provider}/${item.id}` === effective.model);
        // Keep an available current selection visible when filtering another
        // provider. An unavailable saved value is displayed but not selectable.
        const choices = currentModel && !models.includes(currentModel) ? [currentModel, ...models] : models;
        return (
          <section className="role-model-card" key={role.id} aria-label={t("{0} 模型配置", role.label)}>
            <h5>{role.label}</h5>
            <p>{role.description}</p>
            <div className="form-grid">
              <label className="form-field">
                <span>{role.label}{t(" 模型")}</span>
                <select value={model} onChange={event => {
                  const value = event.target.value;
                  if (!value || availableModels.some(item => `${item.provider}/${item.id}` === value)) {
                    setConfig(prev => normalizeModelThinkingLevels(updateRoleModelConfig(prev, role.id, { model: value }), catalog));
                  }
                }} className="provider-filter-select" disabled={busy || !catalog || availableModels.length === 0}>
                  <option value="">{role.id === "nodeAgent" ? t("请选择可用模型") : t("使用 Node Agent 默认模型")}</option>
                  {model && !currentModel && <option value={model} disabled>{catalog ? t("已选模型不可用：") : t("当前模型：")}{model}</option>}
                  {choices.map(item => <option key={`${item.provider}/${item.id}`} value={`${item.provider}/${item.id}`}>{item.name || item.id} ({item.provider}/{item.id})</option>)}
                </select>
              </label>
              <label className="form-field">
                <span>{`${role.label}${t(" 思维等级")}`}</span>
                <select value={settings.thinkingLevel} disabled={busy || levels.length <= 1} onChange={event => {
                  const value = event.target.value as ThinkingLevel;
                  if (levels.includes(value)) {
                    setConfig(prev => normalizeModelThinkingLevels(updateRoleModelConfig(prev, role.id, { thinkingLevel: value }), catalog));
                  }
                }} className="provider-filter-select">
                  {!supported && <option value={settings.thinkingLevel} disabled>{thinkingLabels[settings.thinkingLevel]}</option>}
                  {levels.map(value => <option key={value} value={value}>{thinkingLabels[value]}</option>)}
                </select>
                {levels.length === 0 && <small>{t("暂未获取该模型的思维等级，请刷新 Provider 状态。")}</small>}
              </label>
            </div>
            <small className={override ? "role-model-warning" : "role-model-effective"}>
              {override ? t("环境变量覆盖：") : t("保存后使用：")}{effective.model || t("未设置模型")} · {effective.thinkingLevel}
            </small>
            {unavailable && <small className="role-model-warning">{t("当前使用的模型不可用，请先认证对应 Provider 或重新选择可用模型。")}</small>}
            {role.id === "nodeAgent" && (envOverrides.merger || envOverrides.mergerThinking) && (
              <small className="role-model-warning">{t("Merger 环境变量覆盖：")}{envOverrides.merger || settings.model} · {envOverrides.mergerThinking || settings.thinkingLevel}</small>
            )}
          </section>
        );
      })}
    </div>
  );
}
