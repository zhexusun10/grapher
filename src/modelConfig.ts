import { t } from "./i18n";
import type { Config, ConversationModelConfig, Execution, ModelRole, RoleModelConfig, ThinkingLevel } from "./types";
import type { ProviderCatalog } from "./services/providerAuth";

export const modelRoles: Array<{ id: ModelRole; label: string; description: string }> = [
  { id: "nodeAgent", label: "Node Agent", description: t("负责 Serial 与 Graph 节点的实际执行。其他未单独设置的角色使用此模型作为默认值。") },
  { id: "planner", label: "Planner", description: t("负责分析项目并生成执行拓扑图。推荐选择中大型模型，以获得更可靠的规划能力。") },
  { id: "partitioner", label: "Partitioner", description: t("负责判断任务走 Serial 还是 Graph。推荐选择小型、低延迟模型。") },
];

export const THINKING_LEVEL_SCALE: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export function defaultRoleThinkingLevel(
  role: ModelRole,
  levels?: ThinkingLevel[],
  fallbacks?: Partial<Record<ThinkingLevel, ThinkingLevel>>
): ThinkingLevel {
  const supported = levels && levels.length > 0
    ? THINKING_LEVEL_SCALE.filter(l => levels.includes(l))
    : [];

  if (supported.length === 0) {
    if (role === "planner") return "high";
    return "low";
  }

  const n = supported.length;
  if (role === "planner") {
    // Planner 默认为最高可用的等级
    return supported[n - 1];
  }

  if (role === "nodeAgent") {
    // Node Agent 默认最高可用等级的低一档（若只有一档则使用该档）
    return n >= 2 ? supported[n - 2] : supported[0];
  }

  // Partitioner 默认为低
  if (supported.includes("low")) {
    return "low";
  }
  if (fallbacks?.low && supported.includes(fallbacks.low)) {
    return fallbacks.low;
  }
  return supported[0];
}

/** Project one conversation's saved selection onto the shared settings object. */
export function applyModelConfig(config: Config, settings: ConversationModelConfig | null | undefined): Config {
  return {
    ...config,
    model: settings?.model ?? "",
    thinkingLevel: settings?.thinkingLevel ?? "low",
    roleModels: settings?.roleModels,
  };
}

export function roleModelConfig(config: Config, role: ModelRole, envOverrides: Record<string, string> = {}): Required<RoleModelConfig> {
  const settings = config.roleModels?.[role];
  const envLevel = envOverrides[`${role}Thinking`];
  if (envLevel) {
    return {
      model: envOverrides[role]?.trim() || settings?.model?.trim() || config.model.trim(),
      thinkingLevel: envLevel as ThinkingLevel,
    };
  }
  if (settings?.thinkingLevel) {
    return {
      model: envOverrides[role]?.trim() || settings.model?.trim() || config.model.trim(),
      thinkingLevel: settings.thinkingLevel,
    };
  }
  const defaultLevel: ThinkingLevel =
    role === "partitioner"
      ? "low"
      : role === "planner"
        ? (config.thinkingLevel && config.thinkingLevel !== "low" ? config.thinkingLevel : "high")
        : config.thinkingLevel || "low";
  return {
    model: envOverrides[role]?.trim() || settings?.model?.trim() || config.model.trim(),
    thinkingLevel: defaultLevel,
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

// Project a settings draft using Pi's own clamping results. Unknown capabilities
// leave saved values untouched, including unavailable or retired models.
export function normalizeModelThinkingLevels(config: Config, catalog?: ProviderCatalog): Config {
  const resolved = new Map<ModelRole, ThinkingLevel>();
  for (const { id } of modelRoles) {
    const roleConfig = config.roleModels?.[id];
    const settings = roleModelConfig(config, id);
    const model = catalog?.models.find(item => `${item.provider}/${item.id}` === settings.model);
    const levels = model?.thinkingLevels;
    let level: ThinkingLevel;
    if (roleConfig?.thinkingLevel) {
      level = roleConfig.thinkingLevel;
      if (levels?.length && !levels.includes(level)) {
        const fallback = model?.thinkingLevelFallbacks?.[level];
        if (fallback && levels.includes(fallback)) level = fallback;
        else level = defaultRoleThinkingLevel(id, levels, model?.thinkingLevelFallbacks);
      }
    } else if ((id === "nodeAgent" || config.thinkingLevel === "off") && config.thinkingLevel && config.thinkingLevel !== "low") {
      level = config.thinkingLevel;
      if (levels?.length && !levels.includes(level)) {
        const fallback = model?.thinkingLevelFallbacks?.[level];
        if (fallback && levels.includes(fallback)) level = fallback;
        else level = defaultRoleThinkingLevel(id, levels, model?.thinkingLevelFallbacks);
      }
    } else {
      level = levels?.length
        ? defaultRoleThinkingLevel(id, levels, model?.thinkingLevelFallbacks)
        : settings.thinkingLevel;
    }
    resolved.set(id, level);
  }
  let normalized = config;
  // Resolve every role against the original intent before updating the legacy
  // default; otherwise clamping Node Agent could change another model's intent.
  for (const role of ["nodeAgent", "partitioner", "planner"] as const) {
    const thinkingLevel = resolved.get(role);
    if (thinkingLevel && thinkingLevel !== roleModelConfig(normalized, role).thinkingLevel) {
      normalized = updateRoleModelConfig(normalized, role, { thinkingLevel });
    }
  }
  return normalized;
}

export function planningModelRoles(mode: "auto" | "serial" | "graph"): ModelRole[] {
  return mode === "serial" ? ["nodeAgent"] : mode === "graph" ? ["planner", "nodeAgent"] : ["partitioner", "planner", "nodeAgent"];
}

export function resolveExecutionModelAndThinking(
  execution: Execution,
  isMerger: boolean,
  config: Config,
  envOverrides: Record<string, string> = {},
  nodeModelConfig?: RoleModelConfig
): { model: string; thinkingLevel: string } {
  let modelFromOutput: string | undefined;
  let thinkingFromOutput: string | undefined;

  if (execution.output) {
    const lines = execution.output.split("\n");
    for (const line of lines) {
      if (line.includes("model_change")) {
        try {
          const evt = JSON.parse(line.trim());
          if (evt.type === "model_change") {
            const mId = evt.modelId || evt.model;
            if (mId) {
              modelFromOutput = evt.provider ? `${evt.provider}/${mId}` : mId;
            }
          }
        } catch {}
      }
      if (line.includes("thinking_level_change")) {
        try {
          const evt = JSON.parse(line.trim());
          if (evt.type === "thinking_level_change" && evt.thinkingLevel) {
            thinkingFromOutput = evt.thinkingLevel;
          }
        } catch {}
      }
    }
  }

  const nodeSettings = (!isMerger && nodeModelConfig) || config.roleModels?.nodeAgent;
  const configModel = isMerger
    ? (envOverrides.merger?.trim() || envOverrides.nodeAgent?.trim() || nodeSettings?.model?.trim() || config.model?.trim() || "")
    : (envOverrides.nodeAgent?.trim() || nodeSettings?.model?.trim() || config.model?.trim() || "");

  const configThinking = isMerger
    ? (envOverrides.mergerThinking?.trim() || envOverrides.nodeAgentThinking?.trim() || nodeSettings?.thinkingLevel || config.thinkingLevel || "low")
    : (envOverrides.nodeAgentThinking?.trim() || nodeSettings?.thinkingLevel || config.thinkingLevel || "low");

  // Durable execution metrics record what actually ran after transcripts are
  // stripped; never substitute the settings newly saved for a future retry.
  return {
    model: execution.metrics?.model || modelFromOutput || configModel || t("未设置模型"),
    thinkingLevel: execution.metrics?.thinkingLevel || thinkingFromOutput || configThinking || "low",
  };
}

