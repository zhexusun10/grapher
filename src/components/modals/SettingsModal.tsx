import React, { useEffect } from "react";
import { motion } from "motion/react";
import { Settings2, FolderGit2, RotateCcw, Terminal, Plus, Check, X, Copy } from "lucide-react";
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
      className="modal-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <motion.section
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        initial={{ opacity: 0, scale: 0.95, y: 14 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 10 }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      >
        <header className="settings-modal-header">
          <div className="settings-header-title-wrap">
            <div className="settings-header-icon">
              <Settings2 size={18} />
            </div>
            <div>
              <h2 id="modal-title">Setting</h2>
              <small>管理工作区、模型、Provider 认证及 Execution Instance 并发参数</small>
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
                <h4>本地项目工作区绑定</h4>
              </div>
              <p className="section-desc">
                支持本地 Git 仓库或任意普通文件夹（自动维护零侵入影子仓库沙箱，不污染原项目）。
              </p>
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
                  提示：未检测到有效 Git 信息，请确保选择的文件夹包含 <code>.git</code>。
                </div>
              )}
            </div>

            {/* Section 2: 模型与 Provider */}
            <div className="settings-card">
              <div className="settings-card-title">
                <Terminal size={16} />
                <h4>模型与 Pi Provider 认证 (/login)</h4>
              </div>
              <ProviderSettings
                model={config.model}
                onModel={model => setConfig(prev => ({ ...prev, model }))}
                effectiveRoleModels={effectiveRoleModels}
                envOverrides={envOverrides}
              />
            </div>

            {/* Section 4: 数据管理 */}
            <div className="settings-card">
              <div className="settings-card-title">
                <RotateCcw size={16} />
                <h4>存储与重置</h4>
              </div>
              <div className="section-desc">
                <p>Grapher 将运行时快照与事件保存在本地 SQLite 数据库中。路径：</p>
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
              <Check size={14} /> 保存所有配置
            </button>
          </footer>
        </div>
      </motion.section>
    </motion.div>
  );
});

SettingsModal.displayName = "SettingsModal";

export default SettingsModal;
