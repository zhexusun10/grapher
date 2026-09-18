import React, { useState } from "react";
import { Folder, GitBranch, Plus, RotateCcw, Settings2, Trash2, Copy } from "lucide-react";
import { ProjectItem } from "../../types";

interface SidebarProps {
  projects: ProjectItem[];
  activeRepo: string;
  onSelectProject: (proj: ProjectItem) => void;
  onOpenProject: () => void;
  onRemoveProject: (project: ProjectItem) => void;
  runs: string[];
  currentRunId: string;
  activeBackendRunId: string | null;
  activeBackendPhase: string | null;
  runIndicators: Record<string, { unread: boolean; phase: string }>;
  onLoadRun: (runId: string) => void;
  onDeleteRun: (runId: string) => void;
  onResetWorkspace: () => void;
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
  onResetWorkspace,
  onOpenSettings,
  isSettingsOpen,
  runLabels = {},
}) => {
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
    <aside className="sidebar">
      <div className="sidebar-brand-row">
        <a className="brand" href="#" onClick={(event) => event.preventDefault()}>
          <strong>Grapher</strong>
        </a>
      </div>

      <div className="nav-section projects-label">
        <span>Workspace</span>
        <div className="section-actions">
          <button
            className="icon-tiny-btn"
            title="添加或打开本地 Git 仓库"
            onClick={onOpenProject}
          >
            <Plus size={14} />
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
                  <Folder size={15} />
                </span>
                <div className="proj-details">
                  <div className="proj-name-row">
                    <strong>{proj.name}</strong>
                    {proj.isShadow && (
                      <span className="proj-branch-pill shadow" title="本地零侵入影子仓库：不污染原项目目录">
                        影子仓库
                      </span>
                    )}
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
            className="icon-tiny-btn"
            title="新建空白工作区"
            onClick={onResetWorkspace}
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      <div className="runs-list">
        {runs.length > 0 ? (
          runs.map((id, index) => {
            const isThisRunActive = activeBackendRunId === id && ["running", "awaiting_approval", "publishing", "merging"].includes(activeBackendPhase ?? "");
            const indicator = runIndicators[id];
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
            <GitBranch size={13} />
            <span>当前项目暂无运行历史</span>
          </div>
        )}
      </div>

      <div className="sidebar-bottom">
        <button
          type="button"
          className={`sidebar-bottom-btn ${isSettingsOpen ? "active" : ""}`}
          onClick={onOpenSettings}
          title="Setting"
        >
          <Settings2 size={15} />
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
            <Copy size={13} />
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
            <Trash2 size={13} />
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
            <Copy size={13} />
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
            <Trash2 size={13} />
            <span>删除此条历史</span>
          </button>
        </div>
      )}
    </aside>
  );
});

Sidebar.displayName = "Sidebar";
