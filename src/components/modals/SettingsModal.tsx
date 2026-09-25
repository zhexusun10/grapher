import React, { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Settings2, RotateCcw, Terminal, Check, X, Copy, Sliders, GitBranch } from "lucide-react";
import { Config, RepositoryInfo } from "../../types";
import { ProviderSettings } from "../ProviderSettings";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: Config;
  setConfig: React.Dispatch<React.SetStateAction<Config>>;
  repoInfo?: RepositoryInfo | null;
  dataPath: string;
  effectiveRoleModels?: Record<string, string>;
  envOverrides?: Record<string, string>;
  onOpenProject?: () => void;
  onDetectRepository?: (path?: string) => void;
  onResetWorkspace?: () => void;
  onClearHistory?: () => void;
  onSaveConfig: (autoApprove: boolean) => void;
}

const PARALLEL_STEPS = [
  { value: 1, tag: "串行" },
  { value: 2 },
  { value: 3 },
  { value: 4, tag: "推荐" },
  { value: 5 },
  { value: 6 },
  { value: 7 },
  { value: 8, tag: "极限" },
];

export const SettingsModal: React.FC<SettingsModalProps> = React.memo(({
  isOpen,
  onClose,
  config,
  setConfig,
  dataPath,
  effectiveRoleModels,
  envOverrides,
  onSaveConfig,
}) => {
  const reduceMotion = useReducedMotion();
  const [autoApprove, setAutoApprove] = useState(config.autoApprove ?? false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  if (!isOpen) return null;

  return (
    <motion.div
      className="modal-backdrop settings-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.3, ease: "easeInOut" }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <motion.section
        className="modal settings-modal"
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
              <h2 id="modal-title">设置</h2>
            </div>
          </div>
          <button className="icon-button" aria-label="关闭弹窗" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="settings-modal-content">
          <div className="settings-sections">
            {/* Section 1: 模型与 Provider */}
            <div className="settings-card">
              <div className="settings-card-title">
                <Terminal size={16} />
                <h4>模型与 Provider</h4>
              </div>
              <ProviderSettings
                model={config.model}
                onModel={model => setConfig(prev => ({ ...prev, model }))}
                thinkingLevel={config.thinkingLevel ?? "medium"}
                onThinkingLevel={thinkingLevel => setConfig(prev => ({ ...prev, thinkingLevel }))}
                effectiveRoleModels={effectiveRoleModels}
                envOverrides={envOverrides}
              />
            </div>

            {/* Section 2: 并发控制 */}
            <div className="settings-card">
              <div className="settings-card-title">
                <Sliders size={16} />
                <h4>并发控制</h4>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div className="settings-control-row">
                  <div className="settings-control-label">
                    <span>并发任务上限</span>
                    <span className="settings-control-badge">{config.maxParallel ?? 4} 并发</span>
                  </div>
                  <div className="settings-slider-wrapper">
                    <input
                      type="range"
                      min={1}
                      max={8}
                      step={1}
                      value={config.maxParallel ?? 4}
                      onChange={(e) => setConfig((prev) => ({ ...prev, maxParallel: Number(e.target.value) }))}
                      className="settings-range-slider"
                      aria-label="并发任务上限"
                    />
                    <div className="settings-slider-ticks-track">
                      {PARALLEL_STEPS.map((step) => {
                        const isSelected = (config.maxParallel ?? 4) === step.value;
                        return (
                          <button
                            key={step.value}
                            type="button"
                            className={`settings-slider-tick-item ${isSelected ? "active" : ""}`}
                            style={{ left: `calc(8px + (100% - 16px) * ${(step.value - 1) / 7})` }}
                            onClick={() => setConfig((prev) => ({ ...prev, maxParallel: step.value }))}
                            title={`设置为 ${step.value} 并发${step.tag ? ` (${step.tag})` : ""}`}
                          >
                            <span className="tick-number">{step.value}</span>
                            {step.tag && <span className="tick-tag">{step.tag}</span>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="settings-card">
              <div className="settings-card-title">
                <GitBranch size={16} />
                <h4>图纸审批</h4>
              </div>
              <label className="settings-toggle-row">
                <span>
                  <strong>Auto Approve</strong>
                  <small>自动批准 Planner 生成的图纸并开始执行</small>
                </span>
                <input
                  type="checkbox"
                  checked={autoApprove}
                  onChange={(event) => setAutoApprove(event.target.checked)}
                  aria-label="Auto Approve Planner 图纸"
                />
              </label>
            </div>

            {/* Section 3: 存储与重置 */}
            <div className="settings-card">
              <div className="settings-card-title">
                <RotateCcw size={16} />
                <h4>存储与重置</h4>
              </div>
              <div className="section-desc">
                <p>数据路径</p>
                <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "4px" }}>
                  <code>{dataPath || "本地系统应用目录"}</code>
                  <button 
                    type="button"
                    className="icon-tiny-btn"
                    onClick={() => navigator.clipboard.writeText(dataPath || "本地系统应用目录")}
                    title="复制路径"
                  >
                    <Copy size={13} />
                  </button>
                </div>
              </div>
            </div>
          </div>

          <footer className="settings-modal-footer">
            <button type="button" className="secondary" onClick={onClose}>
              取消
            </button>
            <button type="button" className="primary save-config-btn" onClick={() => onSaveConfig(autoApprove)}>
              <Check size={14} /> 保存设置
            </button>
          </footer>
        </div>
      </motion.section>
    </motion.div>
  );
});

SettingsModal.displayName = "SettingsModal";

export default SettingsModal;
