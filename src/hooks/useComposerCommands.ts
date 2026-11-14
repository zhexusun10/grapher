import { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { t } from "../i18n";
import { availableCatalogModels, roleModelConfig, normalizeModelThinkingLevels, updateRoleModelConfig } from "../modelConfig";
import type { ThinkingLevel } from "../types";
import { providerAuth } from "../services/providerAuth";
import { runtimeService } from "../services/runtime";
import { blockedCommands, ComposerModels, mergeCommands, parseSlashCommand, type ExtensionUIRequest, type PiCommandCatalog } from "../services/composerCommands";

function scoreMatch(candidate: string, query: string): number {
  if (!query) return 1;
  const lower = candidate.toLowerCase();
  if (lower === query) return 100;
  if (lower.startsWith(query)) return 80;
  if (lower.split(/[-_:.\s/]/).some(part => part.startsWith(query))) return 60;
  if (lower.includes(query)) return 40;
  return 0;
}

type CommandSession = { instance: string; commandId: string; runId: string; node?: string; requests: ExtensionUIRequest[] };
const isDialog = (request: ExtensionUIRequest) => ["select", "confirm", "input", "editor"].includes(request.method ?? "");

async function cancelDialogs(session: CommandSession, requests: ExtensionUIRequest[]) {
  await Promise.all(requests.filter(isDialog).map(request => runtimeService.composerCommand({
    runId: session.runId, node: session.node, instance: session.instance, commandId: session.commandId, operation: "respond",
    response: { type: "extension_ui_response", id: request.id, cancelled: true },
  }).catch(() => {})));
}

export function useComposerCommands({ text, runId, node, planMode, conversationModel, setText }: {
  text: string; runId?: string; node?: string; planMode?: string; conversationModel?: boolean;
  setText: (text: string) => void;
}) {
  const context = useContext(ComposerModels);
  const role = node || (planMode ?? context?.snapshot.planType) === "serial" ? "nodeAgent" : "planner";
  const modelNode = conversationModel ? undefined : node;
  const scopeKey = JSON.stringify([context?.config.repository, runId, node, role, conversationModel]);
  const identity = useRef(scopeKey);
  identity.current = scopeKey;
  const catalog = useSyncExternalStore(providerAuth.subscribeCatalog, providerAuth.getCachedCatalog, () => null);
  const [commands, setCommands] = useState<PiCommandCatalog | null>(null);
  const [ui, setUI] = useState<ExtensionUIRequest[]>([]);
  const [notice, setNotice] = useState("");
  const [scopedModelsOpen, setScopedModelsOpen] = useState(false);
  const active = useRef<CommandSession | null>(null);
  const generation = useRef(0);
  const effectiveConfig = context && modelNode && context.snapshot.nodes[modelNode]?.modelOverride
    ? updateRoleModelConfig(context.config, role, context.snapshot.nodes[modelNode].modelConfig!) : context?.config;
  const settings = effectiveConfig ? roleModelConfig(effectiveConfig, role, context?.envOverrides)
    : { model: "", thinkingLevel: "low" as ThinkingLevel };
  const argument = text.match(/^\/(model|thinking)\s+([^\n]*)$/);
  const mcpArgument = text.match(/^\/mcp\s+([^\n]*)$/);
  const model = catalog?.models.find(item => `${item.provider}/${item.id}` === settings.model);
  const levels = model?.thinkingLevels ?? [];

  useEffect(() => {
    setCommands(null); setUI([]); setNotice(""); setScopedModelsOpen(false);
    return () => {
      generation.current++;
      const session = active.current;
      active.current = null;
      if (session) void cancelDialogs(session, session.requests.splice(0));
    };
  }, [scopeKey]);
  const commandTrigger = text.startsWith("/");
  useEffect(() => {
    if (!commandTrigger) return;
    let disposed = false;
    void providerAuth.catalog().catch(() => {});
    if (runId && !runId.startsWith("pending-")) {
      void runtimeService.composerCommand<PiCommandCatalog>({ runId, node, operation: "catalog" })
        .then(commands => { if (!disposed) setCommands(commands); }).catch(() => {});
    }
    return () => { disposed = true; };
  }, [commandTrigger, scopeKey]);

  const suggestions = useMemo(() => {
    if (argument) {
      const query = argument[2].trim().toLowerCase();
      if (argument[1] === "thinking") {
        const ranked = levels
          .map(level => ({ level, score: scoreMatch(level, query) }))
          .filter(item => item.score > 0);
        if (query) ranked.sort((a, b) => b.score - a.score || a.level.length - b.level.length);
        return ranked.map(({ level, score }) => ({
          title: level, subtitle: settings.thinkingLevel === level ? t("当前") : model?.hidden ? t("当前已选模型已隐藏") : settings.model,
          value: `/thinking ${level}`, score,
        }));
      }
      const models = availableCatalogModels(catalog);
      if (!query) {
        return models.map(model => ({ title: `${model.provider}/${model.id}`, subtitle: model.name, value: `/model ${model.provider}/${model.id}`, score: 1 }));
      }
      const rankedModels = models
        .map(model => {
          const full = `${model.provider}/${model.id}`;
          const score = Math.max(
            scoreMatch(model.id, query),
            scoreMatch(full, query),
            scoreMatch(model.name, query),
            `${full} ${model.name}`.toLowerCase().includes(query) ? 40 : 0,
          );
          return { model, full, score };
        })
        .filter(item => item.score > 0);
      rankedModels.sort((a, b) => b.score - a.score);
      return rankedModels.map(({ model, full, score }) => ({ title: full, subtitle: model.name, value: `/model ${full}`, score }));
    }
    if (mcpArgument) return ["login", "logout", "reconnect"].filter(action => action.startsWith(mcpArgument[1].toLowerCase()))
      .map(action => ({ title: `/mcp ${action}`, subtitle: t("可选：输入服务名；省略时由 Pi 选择服务。"), value: `/mcp ${action} `, score: 80 }));
    const query = text.match(/^\/([^\s/]*)$/)?.[1].toLowerCase();
    if (query === undefined) return [];
    const matched = mergeCommands(commands?.commands ?? [])
      .filter(command => !modelNode || command.name !== "name")
      .map(command => ({ command, score: scoreMatch(command.name, query) }))
      .filter(item => item.score > 0);
    if (query) {
      matched.sort((a, b) => b.score - a.score || a.command.name.length - b.command.name.length);
    }
    return matched.map(({ command, score }) => ({
      title: `/${command.name}`, subtitle: t(command.description ?? "Pi command"), value: `/${command.name} `, score,
    }));
  }, [text, catalog, commands, settings.model, settings.thinkingLevel, modelNode]);

  const respond = async (id: string, response: Record<string, unknown>) => {
    const session = active.current;
    const request = session?.requests.find(request => request.id === id);
    if (!session || !request) return;
    await runtimeService.composerCommand({ runId: session.runId, node: session.node, instance: session.instance, commandId: session.commandId,
      operation: "respond", response: { type: "extension_ui_response", id: request.id, ...response } });
    session.requests = session.requests.filter(item => item.id !== request.id);
    if (active.current === session) setUI([...session.requests]);
  };

  // Keep skills/templates on the normal, durable prompt-submission path.
  const execute = async (text: string): Promise<"prompt" | "handled" | "menu"> => {
    const startedGeneration = generation.current;
    const isCurrent = () => generation.current === startedGeneration && identity.current === scopeKey;
    const command = parseSlashCommand(text);
    if (!command || command.name.startsWith("skill:")) return "prompt";
    if (blockedCommands.has(command.name.toLowerCase().split("/")[0])) throw new Error(t("此指令由 Grapher 管理，不支持在输入框中执行。"));
    if (command.name === "scoped-models") {
      if (command.args) throw new Error(t("使用 /scoped-models 打开全局模型可见性管理。"));
      setScopedModelsOpen(true);
      return "handled";
    }
    if (command.name === "name") {
      if (modelNode) throw new Error(t("节点对话框不支持 /name，请在主对话中使用 /name 重命名会话。"));
      if (!runId || runId.startsWith("pending-")) throw new Error(t("请先开始或打开一个对话，再使用 /name 重命名。"));
      const title = command.args.trim();
      if (!title) throw new Error(t("请输入对话名称，例如：/name 新名称"));
      if (context?.rename) {
        await context.rename(runId, title);
      } else {
        await runtimeService.composerRename({ runId, title });
      }
      if (identity.current === scopeKey) setNotice(t("已重命名对话：{0}", title));
      return "handled";
    }
    if (command.name === "model" || command.name === "thinking") {
      if (!context) throw new Error(t("模型配置尚未就绪。"));
      if (!command.args) { setText(`/${command.name} `); return "menu"; }
      const envKey = command.name === "model" ? role : `${role}Thinking`;
      if (context.envOverrides[envKey]) throw new Error(t("此配置由环境变量覆盖，请先移除环境变量。"));
      const fresh = await providerAuth.catalog();
      if (!isCurrent()) return "menu";
      let patch;
      if (command.name === "model") {
        const matches = availableCatalogModels(fresh).filter(model => `${model.provider}/${model.id}` === command.args || model.id === command.args);
        if (matches.length !== 1) throw new Error(t("请选择唯一且可用的 provider/model。"));
        const selected = matches[0];
        const next = normalizeModelThinkingLevels(updateRoleModelConfig(context.config, role, { ...settings,
          model: `${selected.provider}/${selected.id}` }), fresh);
        patch = roleModelConfig(next, role);
      } else {
        const supported = fresh.models.find(model => `${model.provider}/${model.id}` === settings.model)?.thinkingLevels;
        if (!supported?.length) throw new Error(t("无法读取当前模型的思考等级，请刷新 Provider 配置。"));
        if (!supported.includes(command.args as ThinkingLevel)) throw new Error(t("当前模型不支持此思考等级。"));
        patch = { ...settings, thinkingLevel: command.args as ThinkingLevel };
      }
      await context.save({ runId, node: modelNode, role }, patch);
      if (isCurrent()) setNotice(t("已更新当前会话配置；正在执行的调用保持不变，后续调用使用新配置。"));
      return isCurrent() ? "handled" : "menu";
    }
    if (!runId) throw new Error(t("此 Pi 指令需要活动会话，请先开始对话。"));
    const available = await runtimeService.composerCommand<PiCommandCatalog>({ runId, node, operation: "catalog" });
    if (!isCurrent()) return "menu";
    if (command.name === "mcp" && !available.commands.some(item => item.name === "mcp")) {
      throw new Error(t("当前 Pi 会话未加载 MCP。请在 Settings 启用 MCP 扩展后重新启动该 Agent。"));
    }
    if (available.commands.some(item => item.name === command.name && item.source === "prompt")) return "prompt";
    const session = { runId, node, instance: available.instance, commandId: crypto.randomUUID(), requests: [] as ExtensionUIRequest[] };
    active.current = session;
    let polling: Promise<void> | null = null;
    let editorChanged = false;
    const poll = (): Promise<void> => {
      // A command-ID fence lets an abandoned invocation drain/cancel only its
      // own dialogs, even after another composer reuses this Pi instance.
      if (polling) return polling;
      polling = (async () => {
        try {
          const events = await runtimeService.composerCommand<ExtensionUIRequest[]>({ runId, node, instance: session.instance, commandId: session.commandId, operation: "poll" });
          if (active.current !== session || !isCurrent()) {
            await cancelDialogs(session, events);
            return;
          }
          for (const event of events) {
            if (isDialog(event)) session.requests.push(event);
            else if (event.method === "set_editor_text") { editorChanged = true; setText(event.text ?? ""); }
            else if (event.method === "notify" || event.type === "extension_error") setNotice(event.message ?? event.error ?? "");
            else if (event.method === "setStatus" && event.statusText) setNotice(event.statusText);
            else if (event.method === "setWidget" && event.widgetLines?.length) setNotice(event.widgetLines.join("\n"));
            // Arbitrary terminal component factories have no browser equivalent.
          }
          setUI([...session.requests]);
        } finally { polling = null; }
      })();
      return polling;
    };
    const timer = setInterval(() => { void poll().catch(() => {}); }, 200);
    try {
      const result = await runtimeService.composerCommand({ runId, node, instance: session.instance, commandId: session.commandId, operation: "execute", text });
      // Join an earlier read, then drain events emitted immediately before
      // the command acknowledgement (notifications/editor replacement).
      await poll().catch(() => {});
      await poll().catch(() => {});
      if (isCurrent() && ["stats", "session"].includes(command.name)) setNotice(JSON.stringify(result, null, 2));
      if (isCurrent() && command.name === "copy") {
        const value = (result as { text?: string | null })?.text;
        if (!value) throw new Error(t("当前会话还没有可复制的回复。"));
        await navigator.clipboard.writeText(value);
        if (isCurrent()) setNotice(t("已复制"));
      }
      return editorChanged || !isCurrent() ? "menu" : "handled";
    } finally {
      clearInterval(timer);
      void cancelDialogs(session, session.requests.splice(0));
      if (active.current === session) { active.current = null; setUI([]); }
    }
  };
  return { suggestions, argumentMode: !!argument || !!mcpArgument, execute, ui: ui[0], respond, notice,
    clearNotice: () => setNotice(""), scopedModelsOpen, closeScopedModels: () => setScopedModelsOpen(false) };
}
