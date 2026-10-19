import { t, localizeError, languagePreference, restartFrontendWithLanguage, type LanguagePreference } from "../../i18n";
import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Settings2, RotateCcw, Terminal, ShieldCheck, Check, X, Copy, GitBranch, Languages, RefreshCw, FilePenLine, Brain } from "lucide-react";
import { Config } from "../../types";
import { normalizeModelThinkingLevels } from "../../modelConfig";
import { providerAuth, type ProviderCatalog } from "../../services/providerAuth";
import { ProviderSettings } from "../ProviderSettings";
import { RoleModelSettings } from "../RoleModelSettings";
import { ExtensionSettings } from "../ExtensionSettings";
import { normalizeWorkspacePath } from "../../services/workspaceConversations";
import { autoExpandCotEnabled, setAutoExpandCot } from "../../services/displayPreferences";
import { ConfirmModal } from "./ConfirmModal";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: Config;
  dataPath: string;
  envOverrides?: Record<string, string>;
  conversationScoped?: boolean;
  onSaveConfig: (config: Config) => void | Promise<boolean>;
}

export const SettingsModal: React.FC<SettingsModalProps> = React.memo(({
  isOpen,
  onClose,
  config,
  dataPath,
  envOverrides,
  conversationScoped = false,
  onSaveConfig,
}) => {
  const reduceMotion = useReducedMotion();
  const [draftConfig, setDraftConfig] = useState(() => ({ ...config }));
  const [autoApprove, setAutoApprove] = useState(config.autoApprove ?? false);
  const [postTaskReview, setPostTaskReview] = useState(config.postTaskReview ?? true);
  const [plannerWriteTools, setPlannerWriteTools] = useState(config.plannerWriteTools ?? false);
  // Display-only preference, but it follows the same contract as the other
  // toggles: staged here, committed only when the settings save is accepted.
  const [autoExpandCot, setAutoExpandCotDraft] = useState(() => autoExpandCotEnabled());
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [saveError, setSaveError] = useState("");
  const save = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError("");
    try {
      const ok = await onSaveConfig({ ...normalizeModelThinkingLevels(draftConfig, catalog), autoApprove, postTaskReview, plannerWriteTools });
      if (ok === false) {
        savingRef.current = false;
        setSaving(false);
        return;
      }
      // The backend accepted the save, so the browser draft may commit too:
      // cancelling or failing the save leaves the stored preference untouched.
      setAutoExpandCot(autoExpandCot);
    } catch (error) {
      savingRef.current = false;
      setSaving(false);
      setSaveError(String(error));
    }
  };
  const [catalog, setCatalog] = useState<ProviderCatalog | undefined>(() => providerAuth.getCachedCatalog() ?? undefined);
  const [catalogBusy, setCatalogBusy] = useState(() => !providerAuth.getCachedCatalog());
  const [pendingLanguage, setPendingLanguage] = useState<LanguagePreference | null>(null);
  const [languageError, setLanguageError] = useState("");
  const languageLabels: Record<LanguagePreference, string> = {
    auto: t("跟随系统"),
    "zh-CN": t("中文"),
    en: t("英文"),
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Escape dismisses only the confirmation when it is open.
      if (e.key === "Escape" && pendingLanguage === null && !savingRef.current &&
          !document.querySelector(".settings-modal [role='alertdialog']")) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, pendingLanguage]);

  if (!isOpen) return null;

  return (
    <motion.div
      className="modal-backdrop settings-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.3, ease: "easeInOut" }}
    >
      <motion.section
        className="modal settings-modal"
        inert={pendingLanguage !== null}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        initial={{ opacity: 0, scale: 0.985, y: reduceMotion ? 0 : 8 }}
        animate={{ opacity: 1, scale: 1, y: 0, transition: { duration: reduceMotion ? 0 : 0.32, ease: [0.22, 1, 0.36, 1] } }}
        exit={{ opacity: 0, scale: 0.99, y: reduceMotion ? 0 : 6, transition: { duration: reduceMotion ? 0 : 0.24, ease: [0.4, 0, 1, 1] } }}
      >
        <header className="settings-modal-header">
          <div className="settings-header-title-wrap">
            <Settings2 size={18} />
            <h2 id="modal-title">Settings</h2>
          </div>
          <button className="icon-button" aria-label={t("关闭弹窗")} disabled={saving} onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="settings-modal-content">
          <div className="settings-sections">
            <section className="settings-card" aria-labelledby="provider-settings-title">
              <div className="settings-card-title">
                <ShieldCheck size={16} />
                <h4 id="provider-settings-title">{t("模型与 Provider")}</h4>
              </div>
              <ProviderSettings onCatalogChange={setCatalog} onBusyChange={setCatalogBusy} />
            </section>

            <section className="settings-card" aria-labelledby="role-model-settings-title">
              <div className="settings-card-title">
                <Terminal size={16} />
                <h4 id="role-model-settings-title">{t("角色模型配置")}</h4>
              </div>
              <p className="section-desc">{conversationScoped
                ? t("当前显示并编辑此对话的模型配置；保存只影响此对话。")
                : t("当前显示并编辑新对话的默认模型配置；已有对话保留各自配置。")}</p>
              <RoleModelSettings config={draftConfig} setConfig={setDraftConfig} catalog={catalog} envOverrides={envOverrides} busy={catalogBusy || saving} />
            </section>

            <ExtensionSettings disabled={saving} />

            {/* 图纸审批 */}
            <div className="settings-card">
              <div className="settings-card-title">
                <GitBranch size={16} />
                <h4>{t("图纸审批")}</h4>
              </div>
              <label className="settings-toggle-row">
                <span>
                  <strong>Auto Approve</strong>
                  <small>{t("自动批准 Planner 生成的图纸并开始执行")}</small>
                </span>
                <input
                  type="checkbox"
                  checked={autoApprove}
                  disabled={saving}
                  onChange={(event) => setAutoApprove(event.target.checked)}
                  aria-label={t("Auto Approve Planner 图纸")}
                />
              </label>
              <label className="settings-toggle-row">
                <span>
                  <strong>{t("任务后 Planner 复盘")}</strong>
                  <small>{t("任务完成并写回后，让 Planner 决定下一步。新任务遵循自动审批设置。")}</small>
                </span>
                <input
                  type="checkbox"
                  checked={postTaskReview}
                  disabled={saving}
                  onChange={(event) => setPostTaskReview(event.target.checked)}
                  aria-label={t("任务后 Planner 复盘")}
                />
              </label>
            </div>

            {/* Planner 工具 */}
            <div className="settings-card">
              <div className="settings-card-title">
                <FilePenLine size={16} />
                <h4>{t("Planner 文件工具")}</h4>
              </div>
              <label className="settings-toggle-row">
                <span>
                  <strong>{t("挂载 write 和 edit 工具")}</strong>
                  <small>{t("允许 Planner 直接修改工作区文件；默认关闭。关闭时不再挂载 write 和 edit，但 read、Bash、node/edge 及扩展工具仍然可用。对后续规划生效。")}</small>
                </span>
                <input
                  type="checkbox"
                  checked={plannerWriteTools}
                  disabled={saving}
                  onChange={(event) => setPlannerWriteTools(event.target.checked)}
                  aria-label={t("挂载 Planner write 和 edit 工具")}
                />
              </label>
            </div>

            {/* 思维链展示 */}
            <div className="settings-card">
              <div className="settings-card-title">
                <Brain size={16} />
                <h4>{t("思维链展示")}</h4>
              </div>
              <label className="settings-toggle-row">
                <span>
                  <strong>{t("执行时自动展开思维链")}</strong>
                  <small>{t("节点或 Planner 思考时自动展开 COT 卡片。关闭时保持折叠，点击标题才展开；折叠状态不渲染卡片内容。")}</small>
                </span>
                <input
                  type="checkbox"
                  checked={autoExpandCot}
                  disabled={saving}
                  onChange={(event) => setAutoExpandCotDraft(event.target.checked)}
                  aria-label={t("执行时自动展开思维链")}
                />
              </label>
            </div>

            <section className="settings-card" aria-labelledby="language-settings-title">
              <div className="settings-card-title">
                <Languages size={16} />
                <h4 id="language-settings-title">{t("界面语言")}</h4>
              </div>
              <div className="settings-language-row">
                <p className="section-desc">{t("切换语言需确认并重启前端后生效。")}</p>
                <select
                  aria-label={t("界面语言")}
                  disabled={saving}
                  value={languagePreference}
                  onChange={(event) => {
                    const next = event.target.value as LanguagePreference;
                    if (next === languagePreference) return;
                    setLanguageError("");
                    setPendingLanguage(next);
                  }}
                >
                  <option value="auto">{languageLabels.auto}</option>
                  <option value="zh-CN">{languageLabels["zh-CN"]}</option>
                  <option value="en">{languageLabels.en}</option>
                </select>
              </div>
              {languageError && <p role="alert" className="settings-language-error">{languageError}</p>}
            </section>

            {/* 存储与重置 */}
            <div className="settings-card">
              <div className="settings-card-title">
                <RotateCcw size={16} />
                <h4>{t("存储与重置")}</h4>
              </div>
              <div className="section-desc">
                <p>{t("数据路径")}</p>
                <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "4px" }}>
                  <code>{normalizeWorkspacePath(dataPath) || t("本地系统应用目录")}</code>
                  <button 
                    type="button"
                    className="icon-tiny-btn"
                    disabled={!dataPath}
                    onClick={() => {
                      const cleanPath = normalizeWorkspacePath(dataPath);
                      if (cleanPath) void navigator.clipboard.writeText(cleanPath);
                    }}
                    aria-label={t("复制路径")}
                  >
                    <Copy size={13} />
                  </button>
                </div>
              </div>
            </div>
          </div>

          {saveError && <p role="alert" className="settings-language-error">{localizeError(saveError)}</p>}
          <footer className="settings-modal-footer">
            <button type="button" className="settings-cancel-btn" disabled={saving} onClick={onClose}>
              {t("取消")}
            </button>
            <button type="button" className="primary save-config-btn" disabled={saving || catalogBusy} onClick={() => void save()}>
              <Check size={18} />{t(" 保存设置")}
            </button>
          </footer>
        </div>
      </motion.section>
      <AnimatePresence>
        {pendingLanguage !== null && (
          <ConfirmModal
            key="language-confirmation"
            config={{
              title: t("切换语言并重启前端？"),
              message: t("将界面语言切换为「{0}」并重新加载前端。", languageLabels[pendingLanguage]),
              detail: t("尚未保存的设置和输入内容可能丢失。仅重新加载前端，不会重启后端或停止后台任务。"),
              confirmText: t("确认并重启前端"),
              icon: <RefreshCw size={18} />,
              onConfirm: () => {
                try {
                  restartFrontendWithLanguage(pendingLanguage);
                } catch {
                  setLanguageError(t("无法保存语言偏好，请检查浏览器是否允许本地存储后重试。"));
                }
              },
            }}
            onClose={() => setPendingLanguage(null)}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
});

SettingsModal.displayName = "SettingsModal";

export default SettingsModal;
