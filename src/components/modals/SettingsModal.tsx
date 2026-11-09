import { t, localizeError, languagePreference, restartFrontendWithLanguage, type LanguagePreference } from "../../i18n";
import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { RotateCcw, Terminal, Cpu, Check, X, Copy, GitBranch, Languages, RefreshCw, FilePenLine, Brain, Wallpaper } from "lucide-react";
import { Config } from "../../types";
import { normalizeModelThinkingLevels } from "../../modelConfig";
import { providerAuth, type ProviderCatalog } from "../../services/providerAuth";
import { ProviderSettings } from "../ProviderSettings";
import { RoleModelSettings } from "../RoleModelSettings";
import { ExtensionSettings } from "../ExtensionSettings";
import { normalizeWorkspacePath } from "../../services/workspaceConversations";
import { autoExpandCotEnabled, setAutoExpandCot, currentLandingBackground, setLandingBackground } from "../../services/displayPreferences";
import { DotPattern } from "../ui/dot-pattern";
import { ConfirmModal } from "./ConfirmModal";
import { dialogVeilMotion, largeDialogMotion } from "./dialogMotion";

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
  const [landingBackground, setLandingBackgroundDraft] = useState(() => currentLandingBackground());
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [saveError, setSaveError] = useState("");
  // The modal mounts before the background Run re-read finishes, so it can
  // briefly hold a stale conversation config. Adopt the refreshed config while
  // the draft is untouched; once the user edits, their draft wins.
  const dirtyRef = useRef(false);
  const syncedConfigRef = useRef(config);
  const markDirty = () => { dirtyRef.current = true; };
  const updateDraftConfig: React.Dispatch<React.SetStateAction<Config>> = (action) => {
    dirtyRef.current = true;
    setDraftConfig(action);
  };
  useEffect(() => {
    if (config === syncedConfigRef.current) return;
    syncedConfigRef.current = config;
    if (dirtyRef.current) return;
    setDraftConfig({ ...config });
    setAutoApprove(config.autoApprove ?? false);
    setPostTaskReview(config.postTaskReview ?? true);
    setPlannerWriteTools(config.plannerWriteTools ?? false);
  }, [config]);
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
      setLandingBackground(landingBackground);
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

  const dialogMotion = largeDialogMotion(reduceMotion);
  const veilMotion = dialogVeilMotion(reduceMotion);

  return (
    <div className="modal-backdrop subtle-backdrop">
      {/* Light translucent veil only: a full-screen backdrop-filter forced the
          browser onto a slow compositing path and made even modal scrolling
          janky. Only this layer fades, via a cheap compositor opacity change. */}
      <motion.div
        className="modal-backdrop-tint"
        aria-hidden="true"
        {...veilMotion}
      />
      <motion.section
        className="modal settings-modal surface-modal"
        inert={pendingLanguage !== null}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        {...dialogMotion}
      >
        <header className="settings-modal-header">
          <div className="settings-header-title-wrap">
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
                <Cpu size={16} />
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
              <RoleModelSettings config={draftConfig} setConfig={updateDraftConfig} catalog={catalog} envOverrides={envOverrides} busy={catalogBusy || saving} />
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
                  onChange={(event) => { markDirty(); setAutoApprove(event.target.checked); }}
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
                  onChange={(event) => { markDirty(); setPostTaskReview(event.target.checked); }}
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
                  onChange={(event) => { markDirty(); setPlannerWriteTools(event.target.checked); }}
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

            <section className="settings-card" aria-labelledby="background-settings-title">
              <div className="settings-card-title">
                <Wallpaper size={16} />
                <h4 id="background-settings-title">{t("首页背景")}</h4>
              </div>
              <p className="section-desc">{t("选择首页背景，保存后在此浏览器中生效。")}</p>
              <fieldset className="settings-background-options" disabled={saving}>
                <legend className="sr-only">{t("首页背景")}</legend>
                <label className={`settings-background-option ${landingBackground === "dots" ? "is-selected" : ""}`}>
                  <span className="settings-background-preview" aria-hidden="true">
                    <DotPattern width={18} height={18} cr={1} className="[mask-image:radial-gradient(130px_circle_at_center,white,transparent)]" />
                  </span>
                  <span className="settings-background-option-label">
                    <input type="radio" name="landing-background" value="dots" checked={landingBackground === "dots"}
                      onChange={() => setLandingBackgroundDraft("dots")} />
                    <span><strong>{t("点阵")}</strong><small>{t("默认的静态渐隐点阵")}</small></span>
                  </span>
                </label>
                <label className={`settings-background-option ${landingBackground === "paths" ? "is-selected" : ""}`}>
                  <span className="settings-background-preview settings-background-preview-paths" aria-hidden="true">
                    <svg viewBox="0 0 240 80" preserveAspectRatio="xMidYMid slice" fill="none">
                      <path d="M-25 8 C25 -4 45 72 107 58 S188 0 265 20" />
                      <path d="M-25 20 C25 8 45 84 107 70 S188 12 265 32" />
                      <path d="M-25 -4 C25 -16 45 60 107 46 S188 -12 265 8" />
                      <path d="M-25 32 C25 20 45 96 107 82 S188 24 265 44" />
                    </svg>
                  </span>
                  <span className="settings-background-option-label">
                    <input type="radio" name="landing-background" value="paths" checked={landingBackground === "paths"}
                      onChange={() => setLandingBackgroundDraft("paths")} />
                    <span><strong>{t("动态线条")}</strong><small>{t("流动的动态线条")}</small></span>
                  </span>
                </label>
              </fieldset>
            </section>
          </div>

          {saveError && <p role="alert" className="settings-language-error">{localizeError(saveError)}</p>}
          <footer className="settings-modal-footer">
            <button type="button" className="settings-cancel-btn" disabled={saving} onClick={onClose}>
              {t("取消")}
            </button>
            <button type="button" className="primary save-config-btn" disabled={saving || catalogBusy} onClick={() => void save()}>
              <Check size={18} />{t("保存")}
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
    </div>
  );
});

SettingsModal.displayName = "SettingsModal";

export default SettingsModal;
