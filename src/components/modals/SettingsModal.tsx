import React, { useEffect } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Settings2, FolderGit2, RotateCcw, Terminal, Check, X, Copy, Sliders } from "lucide-react";
import { Config, RepositoryInfo } from "../../types";
import { ProviderSettings } from "../ProviderSettings";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: Config;
  setConfig: React.Dispatch<React.SetStateAction<Config>>;
  repoInfo: RepositoryInfo | null;
  dataPath: string;
  effectiveRoleModels?: Record<string, string>;
  envOverrides?: Record<string, string>;
  onOpenProject: () => void;
  onDetectRepository: (path?: string) => void;
  onResetWorkspace: () => void;
  onClearHistory: () => void;
  onSaveConfig: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = React.memo(({
  isOpen,
  onClose,
  config,
  setConfig,
  repoInfo,
  dataPath,
  effectiveRoleModels,
  envOverrides,
  onOpenProject,
  onDetectRepository,
  onResetWorkspace,
  onClearHistory,
  onSaveConfig,
}) => {
  const reduceMotion = useReducedMotion();

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
            {/* Section 1: 本地项目工作区 */}
            <div className="settings-card">
              <div className="settings-card-title">
                <FolderGit2 size={16} />
                <h4>工作区</h4>
              </div>
              <div className="setting-input-row">
                <input
                  className="repo-path-input"
                  value={config.repository}
                  onChange={(e) => setConfig({ ...config, repository: e.target.value })}
                  placeholder="/Users/username/Projects/my-app"
                />
                <button
                  type="button"
                  className="secondary"
                  onClick={onOpenProject}
                  title="调起系统文件夹选择器"
                >
                  <FolderGit2 size={14} /> 浏览本地目录
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => onDetectRepository(config.repository || undefined)}
                  title="检测 Git 信息"
                >
                  <RotateCcw size={14} /> 检测状态
                </button>
              </div>

              {repoInfo ? (
                <div className="repo-status-card">
                  <div className="repo-status-header">
                    <span className="repo-name">
                      <FolderGit2 size={15} />
                      <strong>{repoInfo.name}</strong>
                    </span>
                    <span className={`status-badge ${repoInfo.clean ? "clean" : "warning"}`}>
                      {repoInfo.clean ? "✓ 工作树干净 (Clean)" : "⚠ 有未提交改动 (Dirty)"}
                    </span>
                  </div>
                  <div className="repo-status-meta">
                    <span>当前分支: <code>{repoInfo.branch}</code></span>
                    {repoInfo.head && <span>HEAD: <code>{repoInfo.head}</code></span>}
                  </div>
                  <div className="repo-status-path">{repoInfo.path}</div>
                </div>
              ) : (
                <div className="repo-status-hint">
                  尚未选择工作区
                </div>
              )}
            </div>

            {/* Section 2: 模型与 Provider */}
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

            {/* Section 3: 执行并发与反馈重试控制 */}
            <div className="settings-card">
              <div className="settings-card-title">
                <Sliders size={16} />
                <h4>并发与重试</h4>
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
                    />
                    <div className="settings-slider-ticks">
                      <span>1 (串行)</span>
                      <span>2</span>
                      <span>4 (推荐)</span>
                      <span>6</span>
                      <span>8 (极限)</span>
                    </div>
                  </div>
                </div>

                <div className="settings-control-row">
                  <div className="settings-control-label">
                    <span>最大反馈重试</span>
                    <span className="settings-control-badge">{config.maxFeedback ?? 3} 次</span>
                  </div>
                  <div className="settings-slider-wrapper">
                    <input
                      type="range"
                      min={0}
                      max={10}
                      step={1}
                      value={config.maxFeedback ?? 3}
                      onChange={(e) => setConfig((prev) => ({ ...prev, maxFeedback: Number(e.target.value) }))}
                      className="settings-range-slider"
                    />
                    <div className="settings-slider-ticks">
                      <span>0 (不重试)</span>
                      <span>3 (推荐)</span>
                      <span>5</span>
                      <span>10</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Section 4: 数据管理 */}
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
            <button type="button" className="primary save-config-btn" onClick={onSaveConfig}>
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
