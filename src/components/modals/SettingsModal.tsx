import { t, localizeError, languagePreference, restartFrontendWithLanguage, type LanguagePreference } from "../../i18n";
import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Settings2, RotateCcw, Terminal, ShieldCheck, Check, X, Copy, GitBranch, Languages, RefreshCw } from "lucide-react";
import { Config } from "../../types";
import type { ProviderCatalog } from "../../services/providerAuth";
import { ProviderSettings } from "../ProviderSettings";
import { RoleModelSettings } from "../RoleModelSettings";
import { ExtensionSettings } from "../ExtensionSettings";
import { ConfirmModal } from "./ConfirmModal";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: Config;
  dataPath: string;
  envOverrides?: Record<string, string>;
  error?: string;
  onSaveConfig: (config: Config) => void | Promise<boolean>;
}

export const SettingsModal: React.FC<SettingsModalProps> = React.memo(({
  isOpen,
  onClose,
  config,
  dataPath,
  envOverrides,
  error,
  onSaveConfig,
}) => {
  const reduceMotion = useReducedMotion();
  const [draftConfig, setDraftConfig] = useState(() => ({ ...config }));
  const [autoApprove, setAutoApprove] = useState(config.autoApprove ?? false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [saveError, setSaveError] = useState("");
  const save = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError("");
    try {
      await onSaveConfig({ ...draftConfig, autoApprove });
    } catch (error) {
      setSaveError(String(error));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const [catalog, setCatalog] = useState<ProviderCatalog>();
  const [catalogBusy, setCatalogBusy] = useState(true);
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
            <div className="settings-header-icon">
              <Settings2 size={18} />
            </div>
            <div>
              <h2 id="modal-title">{t("设置")}</h2>
            </div>
          </div>
          <button className="icon-button" aria-label={t("关闭弹窗")} disabled={saving} onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="settings-modal-content">
          <div className="settings-sections">
            <ExtensionSettings disabled={saving} />
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
              <RoleModelSettings config={draftConfig} setConfig={setDraftConfig} catalog={catalog} envOverrides={envOverrides} busy={catalogBusy || saving} />
            </section>

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
            </div>

            {/* 存储与重置 */}
            <div className="settings-card">
              <div className="settings-card-title">
                <RotateCcw size={16} />
                <h4>{t("存储与重置")}</h4>
              </div>
              <div className="section-desc">
                <p>{t("数据路径")}</p>
                <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "4px" }}>
                  <code>{dataPath || t("本地系统应用目录")}</code>
                  <button 
                    type="button"
                    className="icon-tiny-btn"
                    onClick={() => navigator.clipboard.writeText(dataPath || t("本地系统应用目录"))}
                    title={t("复制路径")}
                  >
                    <Copy size={13} />
                  </button>
                </div>
              </div>
            </div>
          </div>

          {(saveError || error) && <p role="alert" className="settings-language-error">{localizeError(saveError || error || "")}</p>}
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
