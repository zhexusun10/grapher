import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { t } from "../i18n";
import { availableCatalogModels, roleModelConfig, normalizeModelThinkingLevels, updateRoleModelConfig } from "../modelConfig";
import type { ThinkingLevel } from "../types";
import { providerAuth } from "../services/providerAuth";
import { piExtensions } from "../services/piExtensions";
import { runtimeService } from "../services/runtime";
import { copyTextToClipboard } from "../services/externalLink";
import { createUuid } from "../lib/uuid";
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

type CommandSession = { instance: string; commandId: string; runId: string; node?: string; standalone?: boolean; repository?: string; requests: ExtensionUIRequest[] };
type StandaloneCommandState = { status: 'pending' | 'complete' | 'cancelled' | 'failed'; events: ExtensionUIRequest[]; error?: string };
type CommandCatalog = { catalog: PiCommandCatalog; standalone: boolean };
type CommandCatalogState = { key: string; revision: number; result?: CommandCatalog; loading: boolean; error: string };
const isCommandCatalog = (value: PiCommandCatalog | null | undefined): value is PiCommandCatalog =>
  typeof value?.instance === 'string' && Array.isArray(value.commands) && value.commands.every(command =>
    typeof command?.name === 'string' && (command.description === undefined || typeof command.description === 'string'));
const isDialog = (request: ExtensionUIRequest) => ["select", "confirm", "input", "editor"].includes(request.method ?? "");
const AUTO_DISMISS_NOTICE_MS = 4000;

async function cancelDialogs(session: CommandSession, requests: ExtensionUIRequest[]) {
  if (session.standalone) {
    await runtimeService.extensionCommand({ repository: session.repository, instance: session.instance, commandId: session.commandId, operation: 'cancel' }).catch(() => {});
    return;
  }
  await Promise.all(requests.filter(isDialog).map(request => runtimeService.composerCommand({
    runId: session.runId, node: session.node, instance: session.instance, commandId: session.commandId, operation: "respond",
    response: { type: "extension_ui_response", id: request.id, cancelled: true },
  }).catch(() => {})));
}

export function useComposerCommands({ text, repository, runId, node, planMode, conversationModel, setText }: {
  text: string; repository?: string; runId?: string; node?: string; planMode?: string; conversationModel?: boolean;
  setText: (text: string) => void;
}) {
  const context = useContext(ComposerModels);
  const role = node || (planMode ?? context?.snapshot.planType) === "serial" ? "nodeAgent" : "planner";
  const modelNode = conversationModel ? undefined : node;
  const commandRepository = repository || context?.config.repository;
  const scopeKey = JSON.stringify([commandRepository, runId, node, role, conversationModel]);
  const identity = useRef(scopeKey);
  identity.current = scopeKey;
  const catalog = useSyncExternalStore(providerAuth.subscribeCatalog, providerAuth.getCachedCatalog, () => null);
  const selectionRevision = useSyncExternalStore(piExtensions.subscribeSelection, piExtensions.getSelectionRevision, () => 0);
  const catalogKey = JSON.stringify([scopeKey, selectionRevision]);
  const catalogIdentity = useRef(catalogKey);
  catalogIdentity.current = catalogKey;
  const [commandCatalog, setCommandCatalog] = useState<CommandCatalogState>({ key: catalogKey, revision: -1, loading: false, error: '' });
  const [refreshRevision, setRefreshRevision] = useState(0);
  const catalogRequest = useRef<{ key: string; task: Promise<CommandCatalog> } | null>(null);
  const commandResult = commandCatalog.key === catalogKey ? commandCatalog.result : undefined;
  const commandResultFresh = commandCatalog.key === catalogKey && commandCatalog.revision === refreshRevision && Boolean(commandCatalog.result);
  const commands = commandResult?.catalog;
  const [ui, setUI] = useState<ExtensionUIRequest[]>([]);
  const [noticeState, setNoticeState] = useState<{ text: string; autoDismissMs?: number; id: number }>({ text: "", id: 0 });
  const notice = noticeState.text;
  const showNotice = useCallback((text: string, autoDismissMs?: number) => {
    setNoticeState(previous => ({ text, autoDismissMs, id: previous.id + 1 }));
  }, []);
  const clearNotice = useCallback(() => {
    setNoticeState(previous => (previous.text ? { text: "", id: previous.id + 1 } : previous));
  }, []);
  const [scopedModelsOpen, setScopedModelsOpen] = useState(false);
  const active = useRef<CommandSession | null>(null);
  const generation = useRef(0);
  const effectiveConfig = context && modelNode && context.snapshot.nodes[modelNode]?.modelOverride
    ? updateRoleModelConfig(context.config, role, context.snapshot.nodes[modelNode].modelConfig!) : context?.config;
  const settings = effectiveConfig ? roleModelConfig(effectiveConfig, role, context?.envOverrides)
    : { model: "", thinkingLevel: "low" as ThinkingLevel };
  const settingsKey = JSON.stringify([settings.model, settings.thinkingLevel,
    context?.envOverrides[role], context?.envOverrides[`${role}Thinking`]]);
  const settingsIdentity = useRef(settingsKey);
  settingsIdentity.current = settingsKey;
  const argument = text.match(/^\/(model|thinking)\s+([^\n]*)$/);
  const model = catalog?.models.find(item => `${item.provider}/${item.id}` === settings.model);
  const levels = model?.thinkingLevels ?? [];

  useEffect(() => {
    if (!noticeState.text || !noticeState.autoDismissMs) return;
    const timer = setTimeout(() => {
      setNoticeState(previous => (previous.id === noticeState.id ? { text: "", id: previous.id + 1 } : previous));
    }, noticeState.autoDismissMs);
    return () => clearTimeout(timer);
  }, [noticeState]);

  useEffect(() => {
    setUI([]); clearNotice(); setScopedModelsOpen(false);
    return () => {
      generation.current++;
      const session = active.current;
      active.current = null;
      if (session) void cancelDialogs(session, session.requests.splice(0));
    };
  }, [scopeKey, clearNotice]);
  const loadCommandCatalog = useCallback((): Promise<CommandCatalog> => {
    const key = JSON.stringify([catalogKey, refreshRevision]);
    if (catalogRequest.current?.key === key) return catalogRequest.current.task;
    setCommandCatalog(previous => ({ key: catalogKey,
      revision: previous.key === catalogKey ? previous.revision : -1,
      result: previous.key === catalogKey ? previous.result : undefined, loading: true, error: '' }));
    const task = (async () => {
      if (runId && !runId.startsWith('pending-')) {
        const catalog = await runtimeService.composerCommand<PiCommandCatalog>({ runId, node, operation: 'catalog' }).catch(() => null);
        if (isCommandCatalog(catalog)) return { catalog, standalone: false };
      }
      const catalog = await runtimeService.extensionCommand<PiCommandCatalog>({ repository: commandRepository, operation: 'catalog' });
      if (!isCommandCatalog(catalog)) throw new Error('Invalid extension command catalog');
      return { catalog, standalone: true };
    })().then(result => {
      if (catalogIdentity.current === catalogKey && catalogRequest.current?.task === task) {
        setCommandCatalog({ key: catalogKey, revision: refreshRevision, result, loading: false, error: '' });
      }
      return result;
    }, error => {
      if (catalogIdentity.current === catalogKey && catalogRequest.current?.task === task) {
        setCommandCatalog({ key: catalogKey, revision: -1, loading: false, error: t('扩展指令加载失败，请重试。') });
      }
      throw error;
    }).finally(() => { if (catalogRequest.current?.task === task) catalogRequest.current = null; });
    catalogRequest.current = { key, task };
    return task;
  }, [catalogKey, refreshRevision, runId, node, commandRepository]);
  const commandTrigger = /^\/[^\s/]*$/.test(text) || /^\/(model|thinking)\s/.test(text);
  useEffect(() => {
    if (!commandTrigger) return;
    void providerAuth.catalog().catch(() => {});
    void loadCommandCatalog().catch(() => {});
  }, [commandTrigger, loadCommandCatalog]);

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
    const fields = { instance: session.instance, commandId: session.commandId,
      operation: 'respond', response: { type: 'extension_ui_response', id: request.id, ...response } };
    if (session.standalone) await runtimeService.extensionCommand({ repository: session.repository, ...fields });
    else await runtimeService.composerCommand({ runId: session.runId, node: session.node, ...fields });
    session.requests = session.requests.filter(item => item.id !== request.id);
    if (active.current === session) setUI([...session.requests]);
  };

  // Keep skills, templates, paths, and unrecognized slash text on the normal, durable prompt-submission path.
  const execute = async (text: string, options?: { hasAttachment?: boolean }): Promise<"prompt" | "handled" | "menu"> => {
    const startedGeneration = generation.current;
    const isCurrent = () => generation.current === startedGeneration && identity.current === scopeKey;
    const command = parseSlashCommand(text);
    if (!command || command.name.startsWith("skill:")) return "prompt";
    const ensureNoAttachment = () => {
      if (options?.hasAttachment) throw new Error(t("Pi 指令不能携带附件，请先移除附件。"));
    };
    if (blockedCommands.has(command.name.toLowerCase())) {
      if (command.args) return "prompt";
      throw new Error(t("此指令由 Grapher 管理，不支持在输入框中执行。"));
    }
    if (command.name === "scoped-models") {
      ensureNoAttachment();
      if (command.args) throw new Error(t("使用 /scoped-models 打开全局模型可见性管理。"));
      setScopedModelsOpen(true);
      return "handled";
    }
    if (command.name === "name") {
      ensureNoAttachment();
      if (modelNode) throw new Error(t("节点对话框不支持 /name，请在主对话中使用 /name 重命名会话。"));
      if (!runId || runId.startsWith("pending-")) throw new Error(t("请先开始或打开一个对话，再使用 /name 重命名。"));
      const title = command.args.trim();
      if (!title) throw new Error(t("请输入对话名称，例如：/name 新名称"));
      if (context?.rename) {
        await context.rename(runId, title);
      } else {
        await runtimeService.composerRename({ runId, title });
      }
      if (identity.current === scopeKey) showNotice(t("已重命名对话：{0}", title), AUTO_DISMISS_NOTICE_MS);
      return "handled";
    }
    if (command.name === "model" || command.name === "thinking") {
      ensureNoAttachment();
      if (!context) throw new Error(t("模型配置尚未就绪。"));
      if (!command.args) { setText(`/${command.name} `); return "menu"; }
      const envKey = command.name === "model" ? role : `${role}Thinking`;
      if (context.envOverrides[envKey]) throw new Error(t("此配置由环境变量覆盖，请先移除环境变量。"));
      const fresh = await providerAuth.catalog();
      // Settings can change while this catalog read is pending without changing
      // the conversation scope. Never save a patch built from the old selection
      // over that newer edit; leave the command as a draft for an explicit retry.
      if (!isCurrent() || settingsIdentity.current !== settingsKey) return "menu";
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
      if (isCurrent()) showNotice(t("已更新当前会话配置；正在执行的调用保持不变，后续调用使用新配置。"), AUTO_DISMISS_NOTICE_MS);
      return isCurrent() ? "handled" : "menu";
    }
    const requiresHistory = command.name === "compact"
      || (!command.args && ["session", "stats", "copy"].includes(command.name));
    const cachedMatch = commandResult?.catalog.commands.find(item => item.name === command.name);
    const mayUpgradeToActive = Boolean(runId && !runId.startsWith("pending-") && commandResult?.standalone);
    if (commandResultFresh && !requiresHistory && !mayUpgradeToActive && (!cachedMatch || cachedMatch.source === "prompt")) {
      return "prompt";
    }
    const knownExtensionCommand = Boolean(cachedMatch && cachedMatch.source !== "prompt");
    let resolved: CommandCatalog;
    try {
      resolved = await loadCommandCatalog();
    } catch {
      if (requiresHistory || knownExtensionCommand) throw new Error(t('扩展指令加载失败，请重试。'));
      return "prompt";
    }
    if (!isCurrent()) return 'menu';
    const available = resolved.catalog;
    const registeredItem = available.commands.find(item => item.name === command.name);
    const registered = Boolean(registeredItem && registeredItem.source !== "prompt");
    if (!registered && !requiresHistory) return "prompt";
    ensureNoAttachment();
    if (requiresHistory && resolved.standalone) throw new Error(t('此 Pi 指令需要活动会话，请先开始对话。'));
    const repository = commandRepository;
    if (resolved.standalone) {
      const session: CommandSession = { standalone: true, repository, runId: runId ?? '', node, instance: available.instance,
        commandId: createUuid(), requests: [] };
      active.current = session;
      const fields = { repository, instance: session.instance, commandId: session.commandId };
      let editorChanged = false;
      try {
        await runtimeService.extensionCommand({ ...fields, operation: 'execute', text });
        while (isCurrent() && active.current === session) {
          const state = await runtimeService.extensionCommand<StandaloneCommandState>({ ...fields, operation: 'poll' });
          if (!isCurrent() || active.current !== session) return 'menu';
          for (const event of state.events) {
            if (isDialog(event)) session.requests.push(event);
            else if (event.method === 'set_editor_text') { editorChanged = true; setText(event.text ?? ''); }
            else if (event.method === 'notify') showNotice(event.message ?? '');
            else if (event.method === 'setStatus' && event.statusText) showNotice(event.statusText);
            else if (event.method === 'setWidget' && event.widgetLines?.length) showNotice(event.widgetLines.join('\n'));
          }
          setUI([...session.requests]);
          if (state.status === 'failed') throw new Error(state.error);
          if (state.status !== 'pending') {
            if (command.name === "reload" && isCurrent()) setRefreshRevision(value => value + 1);
            return editorChanged ? 'menu' : 'handled';
          }
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        return 'menu';
      } finally {
        void cancelDialogs(session, session.requests.splice(0));
        if (active.current === session) { active.current = null; setUI([]); }
      }
    }
    if (!runId) throw new Error(t("此 Pi 指令需要活动会话，请先开始对话。"));
    const session = { runId, node, instance: available.instance, commandId: createUuid(), requests: [] as ExtensionUIRequest[] };
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
            else if (event.method === "notify" || event.type === "extension_error") showNotice(event.message ?? event.error ?? "");
            else if (event.method === "setStatus" && event.statusText) showNotice(event.statusText);
            else if (event.method === "setWidget" && event.widgetLines?.length) showNotice(event.widgetLines.join("\n"));
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
      if (isCurrent() && ["stats", "session"].includes(command.name)) showNotice(JSON.stringify(result, null, 2));
      if (isCurrent() && command.name === "copy") {
        const value = (result as { text?: string | null })?.text;
        if (!value) throw new Error(t("当前会话还没有可复制的回复。"));
        const copied = await copyTextToClipboard(value);
        if (!copied) throw new Error(t("复制提示词失败，请检查剪贴板权限。"));
        if (isCurrent()) showNotice(t("已复制"), AUTO_DISMISS_NOTICE_MS);
      }
      if (command.name === "reload" && isCurrent()) setRefreshRevision(value => value + 1);
      return editorChanged || !isCurrent() ? "menu" : "handled";
    } finally {
      clearInterval(timer);
      void cancelDialogs(session, session.requests.splice(0));
      if (active.current === session) { active.current = null; setUI([]); }
    }
  };
  return { suggestions, argumentMode: !!argument, execute, ui: ui[0], respond, notice,
    commandsLoading: commandCatalog.key === catalogKey && commandCatalog.loading,
    commandsError: commandCatalog.key === catalogKey ? commandCatalog.error : '',
    refreshCommands: () => setRefreshRevision(value => value + 1),
    clearNotice, scopedModelsOpen, closeScopedModels: () => setScopedModelsOpen(false) };
}
