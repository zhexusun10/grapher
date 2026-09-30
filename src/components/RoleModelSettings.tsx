import React, { useId, useState } from "react";
import { X } from "lucide-react";
import type { Config, ThinkingLevel } from "../types";
import type { ProviderCatalog } from "../services/providerAuth";
import { modelRoles, roleModelConfig, updateRoleModelConfig } from "../modelConfig";

const thinkingLevels: Array<[ThinkingLevel, string]> = [
  ["off", "关闭"], ["minimal", "最少 (minimal)"], ["low", "低 (low)"],
  ["medium", "中 (medium)"], ["high", "高 (high)"], ["xhigh", "极高 (xhigh)"], ["max", "最大 (max)"],
];

export function RoleModelSettings({ config, setConfig, catalog, envOverrides = {}, busy }: {
  config: Config;
  setConfig: React.Dispatch<React.SetStateAction<Config>>;
  catalog?: ProviderCatalog;
  envOverrides?: Record<string, string>;
  busy: boolean;
}) {
  const listId = useId();
  const [providerFilter, setProviderFilter] = useState("");
  const models = catalog?.models.filter(model => !providerFilter || model.provider === providerFilter) ?? [];
  return (
    <div className="role-model-settings">
      <label className="form-field">
        <span>模型列表 Provider 筛选</span>
        <select value={providerFilter} disabled={busy} onChange={event => setProviderFilter(event.target.value)} className="provider-filter-select">
          <option value="">全部 Provider</option>
          {catalog?.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name} ({provider.id}){provider.configured ? " ✓ 已认证" : ""}</option>)}
        </select>
      </label>
      <datalist id={listId}>
        {models.map(model => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name}{model.available ? " · 可用" : ""}</option>)}
      </datalist>
      {modelRoles.map(role => {
        const selected = config.roleModels?.[role.id];
        const model = selected?.model ?? (role.id === "nodeAgent" ? config.model : "");
        const settings = roleModelConfig(config, role.id);
        const effective = roleModelConfig(config, role.id, envOverrides);
        const override = envOverrides[role.id] || envOverrides[`${role.id}Thinking`];
        return (
          <section className="role-model-card" key={role.id} aria-label={`${role.label} 模型配置`}>
            <h5>{role.label}</h5>
            <p>{role.description}</p>
            <div className="form-grid">
              <label className="form-field">
                <span>{role.label} 模型</span>
                <div className="model-input-wrapper">
                  <input list={listId} value={model} onChange={event => setConfig(prev => updateRoleModelConfig(prev, role.id, { model: event.target.value }))}
                    placeholder={role.id === "nodeAgent" ? "provider/model" : "留空使用 Node Agent 默认模型"} className="model-text-input" />
                  {model && <button type="button" className="model-input-clear-btn" onClick={() => setConfig(prev => updateRoleModelConfig(prev, role.id, { model: "" }))} aria-label={`清空 ${role.label} 模型`}><X size={13} /></button>}
                </div>
                {model && !model.includes("/") && <small className="role-model-warning">请使用 provider/model 格式。</small>}
                <select value={models.some(item => `${item.provider}/${item.id}` === model) ? model : ""}
                  onChange={event => { if (event.target.value) setConfig(prev => updateRoleModelConfig(prev, role.id, { model: event.target.value })); }} className="provider-filter-select" disabled={busy}>
                  <option value="">从模型列表选择</option>
                  {models.map(item => <option key={`${item.provider}/${item.id}`} value={`${item.provider}/${item.id}`}>{item.provider}/{item.id} ({item.name}){item.available ? " · 可用" : ""}</option>)}
                </select>
              </label>
              <label className="form-field">
                <span>{role.label} 思维等级</span>
                <select value={settings.thinkingLevel} onChange={event => setConfig(prev => updateRoleModelConfig(prev, role.id, { thinkingLevel: event.target.value as ThinkingLevel }))} className="provider-filter-select">
                  {thinkingLevels.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
            </div>
            <small className={override ? "role-model-warning" : "role-model-effective"}>
              {override ? "环境变量覆盖：" : "保存后使用："}{effective.model || "未设置模型"} · {effective.thinkingLevel}
            </small>
            {role.id === "nodeAgent" && (envOverrides.merger || envOverrides.mergerThinking) && (
              <small className="role-model-warning">Merger 环境变量覆盖：{envOverrides.merger || settings.model} · {envOverrides.mergerThinking || settings.thinkingLevel}</small>
            )}
          </section>
        );
      })}
    </div>
  );
}
