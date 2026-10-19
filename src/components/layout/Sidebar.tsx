import { t } from "../../i18n";
import React, { useState } from "react";
import { createPortal } from "react-dom";
import { Plus, Settings2, Trash2, Copy, PanelLeftClose, PanelLeftOpen, Loader2 } from "lucide-react";
import { ProjectItem } from "../../types";
import { normalizeWorkspacePath, workspaceKey } from "../../services/workspaceConversations";

export { normalizeWorkspacePath } from "../../services/workspaceConversations";

interface SidebarProps {
  projects: ProjectItem[];
  activeRepo: string;
  onSelectProject: (proj: ProjectItem) => void;
  onOpenProject: () => void;
  onRemoveProject: (project: ProjectItem) => void;
  runs: string[];
  currentRunId: string;
  activeBackendRunId?: string | null;
  activeBackendPhase?: string | null;
  runIndicators: Record<string, { unread: boolean; phase: string }>;
  onLoadRun: (runId: string) => void;
  onDeleteRun: (runId: string) => void;
  onNewConversation: () => void;
  onOpenSettings: () => void;
  isSettingsOpen: boolean;
  runLabels?: Record<string, string>;
  isReady?: boolean;
  isOpeningProject?: boolean;
  switchingProjectPath?: string | null;
  loadingRunId?: string | null;
}

export const Sidebar: React.FC<SidebarProps> = React.memo(({
  projects,
  activeRepo,
  onSelectProject,
  onOpenProject,
  onRemoveProject,
  runs,
  currentRunId,
  activeBackendRunId,
  activeBackendPhase,
  runIndicators,
  onLoadRun,
  onDeleteRun,
  onNewConversation,
  onOpenSettings,
  isSettingsOpen,
  runLabels = {},
  isReady = true,
  isOpeningProject = false,
  switchingProjectPath = null,
  loadingRunId = null,
}) => {
  const [isCollapsed, setIsCollapsed] = useState(() => {
    try {
      return localStorage.getItem("grapher_sidebar_collapsed_v1") === "true";
    } catch {
      return false;
    }
  });
  const toggleCollapsed = () => {
    const next = !isCollapsed;
    setIsCollapsed(next);
    setProjectContextMenu(null);
    setRunContextMenu(null);
    try {
      localStorage.setItem("grapher_sidebar_collapsed_v1", String(next));
    } catch {
      // Keep the toggle usable when browser storage is unavailable.
    }
  };

  const [projectContextMenu, setProjectContextMenu] = useState<{ x: number; y: number; project: ProjectItem } | null>(null);
  const [runContextMenu, setRunContextMenu] = useState<{ x: number; y: number; runId: string } | null>(null);

  React.useEffect(() => {
    const handleClose = () => {
      setProjectContextMenu(null);
      setRunContextMenu(null);
    };
    window.addEventListener("click", handleClose);
    window.addEventListener("contextmenu", handleClose);
    return () => {
      window.removeEventListener("click", handleClose);
      window.removeEventListener("contextmenu", handleClose);
    };
  }, []);

  return (
    <aside className={`sidebar${isCollapsed ? " is-collapsed" : ""}`} aria-label={t("侧边栏")}>
      <div className="sidebar-brand-row">
        <div className="brand">
          <strong>Grapher</strong>
        </div>
        <button
          type="button"
          className="sidebar-toggle-btn"
          onClick={toggleCollapsed}
          aria-label={isCollapsed ? t("展开侧边栏") : t("收起侧边栏")}
          title={isCollapsed ? t("展开侧边栏") : t("收起侧边栏")}
          aria-expanded={!isCollapsed}
        >
          {isCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
        </button>
      </div>

      <div className="nav-section projects-label">
        <span>Workspace</span>
        <div className="section-actions">
          <button
            type="button"
            className="sidebar-add-btn icon-tiny-btn"
            aria-label={t("添加或打开本地 Git 仓库")}
            onClick={onOpenProject}
            disabled={isOpeningProject}
            aria-busy={isOpeningProject}
          >
            {isOpeningProject ? <Loader2 size={16} className="sidebar-btn-spin" /> : <Plus size={18} />}
          </button>
        </div>
      </div>

      <div className="projects-list">
        {projects.length > 0 ? (
          projects.map((proj, index) => {
            const isActive = workspaceKey(activeRepo) === workspaceKey(proj.path);
            const isSwitching = switchingProjectPath ? workspaceKey(switchingProjectPath) === workspaceKey(proj.path) : false;
            return (
              <div
                key={proj.path}
                className={`project-workspace-item ${isActive ? "active" : ""} ${isSwitching ? "is-switching" : ""}`}
                style={{ "--proj-index": Math.min(index, 8) } as React.CSSProperties}
                onClick={() => onSelectProject(proj)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setRunContextMenu(null);
                  setProjectContextMenu({ x: e.clientX, y: e.clientY, project: proj });
                }}
              >
                <div className="proj-details">
                  <div className="proj-name-row">
                    <strong>{proj.name}</strong>
                  </div>
                  <small className="proj-path-text">{normalizeWorkspacePath(proj.path)}</small>
                </div>
              </div>
            );
          })
        ) : (
          <div className="projects-placeholder">
            <span>{t("暂无工作区")}</span>
          </div>
        )}
      </div>

      <div className="nav-section runs-label">
        <span>Conversation</span>
        <div className="section-actions">
          <button
            type="button"
            className="sidebar-add-btn icon-tiny-btn"
            aria-label={t("新建对话")}
            onClick={onNewConversation}
          >
            <Plus size={18} />
          </button>
        </div>
      </div>

      <div className="runs-list">
        {!isReady ? (
          <div className="sidebar-skeleton-wrap" aria-hidden="true">
            <div className="sidebar-skeleton-item">
              <div className="sidebar-skeleton-dot" />
              <div className="sidebar-skeleton-lines">
                <div className="sidebar-skeleton-line title" style={{ width: "75%" }} />
                <div className="sidebar-skeleton-line sub" style={{ width: "45%" }} />
              </div>
            </div>
            <div className="sidebar-skeleton-item">
              <div className="sidebar-skeleton-dot" />
              <div className="sidebar-skeleton-lines">
                <div className="sidebar-skeleton-line title" style={{ width: "60%" }} />
                <div className="sidebar-skeleton-line sub" style={{ width: "35%" }} />
              </div>
            </div>
            <div className="sidebar-skeleton-item">
              <div className="sidebar-skeleton-dot" />
              <div className="sidebar-skeleton-lines">
                <div className="sidebar-skeleton-line title" style={{ width: "80%" }} />
                <div className="sidebar-skeleton-line sub" style={{ width: "50%" }} />
              </div>
            </div>
          </div>
        ) : runs.length > 0 ? (
          runs.map((id, index) => {
            const indicator = runIndicators[id];
            const isThisRunActive = ["running", "awaiting_approval", "publishing", "merging"].includes(indicator?.phase ?? (activeBackendRunId === id ? activeBackendPhase ?? "" : ""));
            const isUnread = Boolean(indicator?.unread && currentRunId !== id);
            const needsUnreadApproval = isUnread && indicator.phase === "awaiting_approval";
            const isChosen = (loadingRunId ?? currentRunId) === id;
            const isLoadingThisRun = loadingRunId === id && currentRunId !== id;
            let displayLabel = `Graph ${id.slice(0, 8)}`;
            const labelText = runLabels[id];
            const isResolvingLabel = !labelText;
            if (labelText) {
              displayLabel = labelText;
            }
            return (
              <button
                data-run-id={id}
                className={`run-item ${isChosen ? "chosen" : ""} ${isLoadingThisRun ? "is-loading" : ""}`}
                style={{ "--item-index": Math.min(index, 12) } as React.CSSProperties}
                key={id}
                onClick={() => onLoadRun(id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setProjectContextMenu(null);
                  setRunContextMenu({ x: e.clientX, y: e.clientY, runId: id });
                }}
              >
                {isThisRunActive ? (
                  <span
                    className="run-dot running-pulse"
                  />
                ) : isUnread ? (
                  <span
                    className={`run-dot ${needsUnreadApproval ? "approval-pulse" : ""}`}
                  />
                ) : null}
                <span className={`run-title-text ${isResolvingLabel ? "is-resolving" : ""}`}>
                  {displayLabel}
                </span>
              </button>
            );
          })
        ) : (
          <div className="run-placeholder">
            <span>{t("暂无对话记录")}</span>
          </div>
        )}
      </div>

      <div className="sidebar-bottom">
        <button
          type="button"
          className={`sidebar-bottom-btn ${isSettingsOpen ? "active" : ""}`}
          onClick={onOpenSettings}
          aria-label="Settings"
        >
          <Settings2 size={18} />
          <span>Settings</span>
        </button>
      </div>

      {projectContextMenu &&
        createPortal(
          <div
            className="context-menu"
            style={{
              left: Math.min(projectContextMenu.x, window.innerWidth - 180),
              top: Math.min(projectContextMenu.y, window.innerHeight - 120),
            }}
            onClick={(e) => e.stopPropagation()}
          >
          <button
            className="context-menu-item"
            onClick={() => {
              navigator.clipboard?.writeText(normalizeWorkspacePath(projectContextMenu.project.path));
              setProjectContextMenu(null);
            }}
          >
            <Copy size={14} />
            <span>{t("复制仓库路径")}</span>
          </button>
          <div className="context-menu-divider" />
          <button
            className="context-menu-item danger"
            onClick={() => {
              const project = projectContextMenu.project;
              setProjectContextMenu(null);
              onRemoveProject(project);
            }}
          >
            <Trash2 size={14} />
            <span>{t("从工作区移除")}</span>
          </button>
          </div>,
          document.body,
        )}

      {runContextMenu &&
        createPortal(
          <div
            className="context-menu"
            style={{
              left: Math.min(runContextMenu.x, window.innerWidth - 180),
              top: Math.min(runContextMenu.y, window.innerHeight - 120),
            }}
            onClick={(e) => e.stopPropagation()}
          >
          <button
            className="context-menu-item"
            onClick={() => {
              navigator.clipboard?.writeText(runContextMenu.runId);
              setRunContextMenu(null);
            }}
          >
            <Copy size={14} />
            <span>{t("复制快照 ID")}</span>
          </button>
          <div className="context-menu-divider" />
          <button
            className="context-menu-item danger"
            disabled={runContextMenu.runId.startsWith("pending-")}
            onClick={() => {
              const runId = runContextMenu.runId;
              setRunContextMenu(null);
              onDeleteRun(runId);
            }}
          >
            <Trash2 size={14} />
            <span>{t("删除此条历史")}</span>
          </button>
          </div>,
          document.body,
        )}
    </aside>
  );
});

Sidebar.displayName = "Sidebar";
