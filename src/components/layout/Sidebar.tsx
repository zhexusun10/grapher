import React, { useState } from "react";
import { Folder, Plus, RotateCcw, Settings2, Trash2, Copy, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { ProjectItem } from "../../types";

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
    <aside className={`sidebar${isCollapsed ? " is-collapsed" : ""}`} aria-label="侧边栏">
      <div className="sidebar-brand-row">
        <div className="brand">
          <strong>Grapher</strong>
        </div>
        <button
          type="button"
          className="sidebar-toggle-btn"
          onClick={toggleCollapsed}
          aria-label={isCollapsed ? "展开侧边栏" : "收起侧边栏"}
          aria-expanded={!isCollapsed}
          title={isCollapsed ? "展开侧边栏" : "收起侧边栏"}
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
            title="添加或打开本地 Git 仓库"
            aria-label="添加或打开本地 Git 仓库"
            onClick={onOpenProject}
          >
            <Plus size={18} />
          </button>
        </div>
      </div>

      <div className="projects-list">
        {projects.length > 0 ? (
          projects.map((proj) => {
            const isActive = activeRepo === proj.path;
            return (
              <div
                key={proj.path}
                className={`project-workspace-item ${isActive ? "active" : ""}`}
                onClick={() => onSelectProject(proj)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setRunContextMenu(null);
                  setProjectContextMenu({ x: e.clientX, y: e.clientY, project: proj });
                }}
                title={`${proj.name}\n${proj.path}\n分支: ${proj.branch}\n(右键管理工作区)`}
              >
                <span className="proj-icon">
                  <Folder size={16} />
                </span>
                <div className="proj-details">
                  <div className="proj-name-row">
                    <strong>{proj.name}</strong>
                  </div>
                  <small className="proj-path-text">{proj.path}</small>
                </div>
              </div>
            );
          })
        ) : (
          <div className="empty-projects-hint" onClick={onOpenProject}>
            <Folder size={24} />
            <span>暂无工作区</span>
            <small>点击打开本地项目文件夹</small>
          </div>
        )}
      </div>

      <div className="nav-section runs-label">
        <span>Conversation</span>
        <div className="section-actions">
          <button
            type="button"
            className="sidebar-add-btn icon-tiny-btn"
            title="新建对话（不停止后台运行）"
            aria-label="新建对话"
            onClick={onNewConversation}
          >
            <Plus size={18} />
          </button>
        </div>
      </div>

      <div className="runs-list">
        {runs.length > 0 ? (
          runs.map((id, index) => {
            const indicator = runIndicators[id];
            const isThisRunActive = ["running", "awaiting_approval", "publishing", "merging"].includes(indicator?.phase ?? (activeBackendRunId === id ? activeBackendPhase ?? "" : ""));
            const isUnread = Boolean(indicator?.unread && currentRunId !== id);
            const needsUnreadApproval = isUnread && indicator.phase === "awaiting_approval";
            let displayLabel = `Graph ${id.slice(0, 8)}`;
            const labelText = runLabels[id];
            if (labelText) {
              displayLabel = labelText;
            }
            return (
              <button
                className={`run-item ${currentRunId === id ? "chosen" : ""} ${isThisRunActive ? "active-running" : ""}`}
                key={id}
                onClick={() => onLoadRun(id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setProjectContextMenu(null);
                  setRunContextMenu({ x: e.clientX, y: e.clientY, runId: id });
                }}
                title={labelText ? `${labelText}\n\n快照: ${id}\n(右键可复制 ID 或删除)` : `快照: ${id}\n(右键可复制 ID 或删除)`}
              >
                {isUnread && (
                  <span
                    className={`run-dot ${needsUnreadApproval ? "approval-pulse" : ""}`}
                    title={needsUnreadApproval ? "有待审批的未读更新" : "有未读更新"}
                  />
                )}
                <span className="run-title-text">
                  {displayLabel}
                </span>
              </button>
            );
          })
        ) : (
          <div className="run-placeholder">
            <span>No conversations for this project</span>
          </div>
        )}
      </div>

      <div className="sidebar-bottom">
        <button
          type="button"
          className={`sidebar-bottom-btn ${isSettingsOpen ? "active" : ""}`}
          onClick={onOpenSettings}
          title="Setting"
          aria-label="设置"
        >
          <Settings2 size={18} />
          <span>Setting</span>
        </button>
      </div>

      {projectContextMenu && (
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
              navigator.clipboard?.writeText(projectContextMenu.project.path);
              setProjectContextMenu(null);
            }}
          >
            <Copy size={14} />
            <span>复制仓库路径</span>
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
            <span>从工作区移除</span>
          </button>
        </div>
      )}

      {runContextMenu && (
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
            <span>复制快照 ID</span>
          </button>
          <div className="context-menu-divider" />
          <button
            className="context-menu-item danger"
            onClick={() => {
              const runId = runContextMenu.runId;
              setRunContextMenu(null);
              onDeleteRun(runId);
            }}
          >
            <Trash2 size={14} />
            <span>删除此条历史</span>
          </button>
        </div>
      )}
    </aside>
  );
});

Sidebar.displayName = "Sidebar";
