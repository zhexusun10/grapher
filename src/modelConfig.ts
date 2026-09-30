import { t } from "./i18n";
import type { Config, ModelRole, RoleModelConfig, ThinkingLevel } from "./types";

export const modelRoles: Array<{ id: ModelRole; label: string; description: string }> = [
  { id: "partitioner", label: "Partitioner", description: t("负责判断任务走 Serial 还是 Graph。推荐选择小型、低延迟模型，思维链默认关闭。") },
  { id: "planner", label: "Planner", description: t("负责分析项目并生成协作拓扑图。推荐选择中大型模型，以获得更可靠的规划能力。") },
  { id: "nodeAgent", label: "Node Agent / Pi Instance", description: t("负责 Serial 与 Graph 节点的实际执行。其他未单独设置的角色使用此模型作为默认值；合并实例也使用此配置。") },
];

export function roleModelConfig(config: Config, role: ModelRole, envOverrides: Record<string, string> = {}): Required<RoleModelConfig> {
  const settings = config.roleModels?.[role];
  return {
    model: envOverrides[role]?.trim() || settings?.model?.trim() || config.model.trim(),
    thinkingLevel: (envOverrides[`${role}Thinking`] || settings?.thinkingLevel || (role === "partitioner" ? "off" : config.thinkingLevel || "medium")) as ThinkingLevel,
  };
}

export function updateRoleModelConfig(config: Config, role: ModelRole, patch: Partial<RoleModelConfig>): Config {
  const current = config.roleModels?.[role] ?? {
    model: role === "nodeAgent" ? config.model : "",
    thinkingLevel: roleModelConfig(config, role).thinkingLevel,
  };
  const settings = { ...current, ...patch };
  return {
    ...config,
    // Keep legacy clients/defaults and unspecialized Merger compatible.
    ...(role === "nodeAgent" ? { model: settings.model, thinkingLevel: settings.thinkingLevel ?? config.thinkingLevel } : {}),
    roleModels: { ...config.roleModels, [role]: settings },
  };
}

export function planningModelRoles(mode: "auto" | "serial" | "graph"): ModelRole[] {
  return mode === "serial" ? ["nodeAgent"] : mode === "graph" ? ["planner", "nodeAgent"] : ["partitioner", "planner", "nodeAgent"];
}
