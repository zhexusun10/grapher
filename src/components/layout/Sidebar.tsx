import { t } from "../../i18n";
import React, { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Plus, Settings2, Trash2, Copy, PanelLeftClose, PanelLeftOpen, Loader2 } from "lucide-react";
import { ProjectItem } from "../../types";
import type { RunIndicator } from "../../hooks/useRunIndicators";
import { normalizeWorkspacePath, workspaceKey } from "../../services/workspaceConversations";
import { workspacePathDisplay } from "./workspacePathDisplay";
import { ContextMenu, contextMenuAnchor, type ContextMenuAnchor } from "../ui/context-menu";

export { normalizeWorkspacePath } from "../../services/workspaceConversations";

// Match the previous CSS entrance while giving cards a real exit, so removing a
// workspace or conversation fades out before the list closes the gap.
const CARD_EASE: [number, number, number, number] = [0.16, 1, 0.3, 1];
// The entrance can snap into place; the removal cannot. The collapse moves the
// cards below, so it uses a gentler curve that spreads the same distance over
// more frames instead of clearing most of it in the first few.
const CARD_COLLAPSE_EASE: [number, number, number, number] = [0.25, 0.46, 0.45, 0.94];

// `.projects-list` separates its cards with a flex `gap`; `.runs-list` spaces
// them with a card margin instead.
const PROJECT_LIST_GAP = 4;

// AnimatePresence keeps an exiting card in the flow until its exit finishes, so
// the exit also closes the card's own box: height, padding, border and spacing
// shrink. Without that, the cards below hold their place for the whole exit and
// then snap upward the moment the card is removed, which reads as a jerk instead
// of a removal.
function cardExit(listGap: number) {
  return {
    opacity: 0,
    height: 0,
    minHeight: 0,
    paddingTop: 0,
    paddingBottom: 0,
    // Only the vertical box closes; the horizontal borders stay so the card's
    // content does not reflow sideways while it fades.
    borderTopWidth: 0,
    borderBottomWidth: 0,
    // A `gap` list keeps the space on both sides while the exiting card is still
    // mounted, so pull the trailing gap back out with a negative margin.
    marginBottom: listGap > 0 ? -listGap : 0,
    overflow: "hidden",
    // The card fades in place first and only then gives its space back. The
    // fading card is a clipping box: collapsing it while its label still has
    // visible alpha leaves the middle of the glyphs behind as a smudge inside a
    // card that already reads as gone, which looks like the text outliving the
    // card. No `y`/`scale` here either, so the removal is one motion (the space
    // closing) instead of the content drifting away from its own box.
    transition: {
      opacity: { duration: 0.13, ease: CARD_COLLAPSE_EASE },
      default: { duration: 0.18, ease: CARD_COLLAPSE_EASE, delay: 0.08 },
    },
  };
}

const PROJECT_CARD_EXIT = cardExit(PROJECT_LIST_GAP);
const RUN_CARD_EXIT = cardExit(0);

// Matches the CSS overlay breakpoint below which the sidebar would otherwise
// take a large share of the width from the single-pane workbench.
const NARROW_SIDEBAR_QUERY = "(max-width: 720px)";

function startsCollapsed(): boolean {
  return typeof window !== "undefined" && window.matchMedia(NARROW_SIDEBAR_QUERY).matches;
}

function cardMotion(reduceMotion: boolean, index: number, skipEntrance = false, listGap = 0) {
  if (reduceMotion) {
    return {
      initial: false,
      animate: { opacity: 1, y: 0 },
      exit: { opacity: 0 },
    };
  }
  return {
    // Cards restored from the initial paint are already part of the sidebar's
    // entrance; replaying a per-card fade makes them blink on every reload.
    initial: skipEntrance ? false : { opacity: 0, y: 6 },
    animate: { opacity: 1, y: 0, transition: { duration: 0.24, ease: CARD_EASE, delay: Math.min(index, 12) * 0.028 } },
    exit: listGap > 0 ? PROJECT_CARD_EXIT : RUN_CARD_EXIT,
  };
}

/**
 * Conversation card. The caller keys it by a stable card key so adopting a
 * durable Run ID after the provisional card reuses the same node instead of
 * remounting it (which would replay the entrance and exit animations).
 */
const RunItem: React.FC<{
  runId: string;
  index: number;
  reduceMotion: boolean;
  skipEntrance?: boolean;
  className?: string;
  onClick: () => void;
  onContextMenu: (event: React.MouseEvent<HTMLButtonElement> | React.KeyboardEvent<HTMLButtonElement>) => void;
  selected: boolean;
  busy: boolean;
  menuOpen: boolean;
  children: React.ReactNode;
}> = ({ runId, index, reduceMotion, skipEntrance = false, className = "", onClick, onContextMenu, selected, busy, menuOpen, children }) => {
  return (
    <motion.button
      type="button"
      aria-current={selected ? "true" : undefined}
      aria-busy={busy}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      data-run-id={runId}
      className={`run-item ${className}`.trim()}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={onContextMenu}
      {...cardMotion(reduceMotion, index, skipEntrance)}
    >
      {children}
    </motion.button>
  );
};

interface SidebarProps {
  projects: ProjectItem[];
  activeRepo: string;
  onSelectProject: (proj: ProjectItem) => void;
  onOpenProject: () => void;
  onRemoveProject: (project: ProjectItem) => void;
  runs: string[];
  currentRunId: string;
  runIndicators: Record<string, RunIndicator>;
  onLoadRun: (runId: string) => void;
  onCopyRunPrompt: (runId: string, provisionalPrompt?: string) => void;
  onCancelPendingPromptCopy: () => void;
  onDeleteRun: (runId: string) => void;
  onNewConversation: () => void;
  onOpenSettings: () => void;
  isSettingsOpen: boolean;
  runLabels?: Record<string, string>;
  runCardKeys?: Record<string, string>;
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
  runIndicators,
  onLoadRun,
  onCopyRunPrompt,
  onCancelPendingPromptCopy,
  onDeleteRun,
  onNewConversation,
  onOpenSettings,
  isSettingsOpen,
  runLabels = {},
  runCardKeys = {},
  isReady = true,
  isOpeningProject = false,
  switchingProjectPath = null,
  loadingRunId = null,
}) => {
  // Wide launches start expanded; narrow windows start with the rail so the
  // composer keeps its room. Collapsing remains session-local.
  const [isCollapsed, setIsCollapsed] = useState(startsCollapsed);
  // Only undo a collapse we caused by resizing; a user's manual choice wins.
  const autoCollapsedRef = React.useRef(isCollapsed);
  const toggleCollapsed = () => {
    autoCollapsedRef.current = false;
    setIsCollapsed(!isCollapsed);
    setProjectContextMenu(null);
    setRunContextMenu(null);
  };

  const [projectContextMenu, setProjectContextMenu] = useState<(ContextMenuAnchor & { project: ProjectItem }) | null>(null);
  const [runContextMenu, setRunContextMenu] = useState<(ContextMenuAnchor & { runId: string; provisionalPrompt?: string }) | null>(null);
  const reduceMotion = useReducedMotion() ?? false;
  // Cards restored on the first paint keep their final visual state; only cards
  // that arrive later (bootstrap, opening a project, or switching workspaces)
  // play the entrance. Run cards behind a skeleton are arrivals too, so only a
  // warm sidebar contributes them here.
  const restoredKeysRef = React.useRef<{ projects: Set<string>; runs: Set<string> } | null>(null);
  if (restoredKeysRef.current === null) {
    restoredKeysRef.current = {
      projects: new Set(projects.map(proj => workspaceKey(proj.path))),
      runs: new Set(isReady ? runs.map(id => runCardKeys[id] ?? id) : []),
    };
  }
  const restoredProjectKeys = restoredKeysRef.current.projects;
  const restoredRunKeys = restoredKeysRef.current.runs;

  React.useEffect(() => {
    const query = window.matchMedia(NARROW_SIDEBAR_QUERY);
    const sync = (narrow: boolean) => {
      if (narrow) {
        setIsCollapsed(previous => {
          if (!previous) autoCollapsedRef.current = true;
          return true;
        });
      } else if (autoCollapsedRef.current) {
        autoCollapsedRef.current = false;
        setIsCollapsed(false);
      }
    };
    sync(query.matches);
    const handleChange = (event: MediaQueryListEvent) => sync(event.matches);
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  const projectCards = projects.map((proj, index) => {
    const isActive = workspaceKey(activeRepo) === workspaceKey(proj.path);
    const isSwitching = switchingProjectPath ? workspaceKey(switchingProjectPath) === workspaceKey(proj.path) : false;
    const openMenu = (event: React.MouseEvent<HTMLButtonElement> | React.KeyboardEvent<HTMLButtonElement>) => {
      const anchor = contextMenuAnchor(event);
      if (!anchor) return;
      setRunContextMenu(null);
      setProjectContextMenu({ ...anchor, project: proj });
    };
    return (
      <motion.button
        type="button"
        key={proj.path}
        aria-label={`${proj.name}\n${normalizeWorkspacePath(proj.path)}`}
        aria-current={isActive ? "true" : undefined}
        aria-busy={isSwitching}
        aria-haspopup="menu"
        aria-expanded={projectContextMenu?.project.path === proj.path}
        className={`project-workspace-item ${isActive ? "active" : ""} ${isSwitching ? "is-switching" : ""}`}
        onClick={() => onSelectProject(proj)}
        onContextMenu={openMenu}
        onKeyDown={openMenu}
        {...cardMotion(reduceMotion, index, restoredProjectKeys.has(workspaceKey(proj.path)), PROJECT_LIST_GAP)}
      >
        <span className="proj-details">
          <span className="proj-name-row">
            <strong>{proj.name}</strong>
          </span>
          <small className="proj-path-text">{workspacePathDisplay(proj.path)}</small>
        </span>
      </motion.button>
    );
  });

  const runCards = runs.map((id, index) => {
    const indicator = runIndicators[id];
    const isThisRunActive = Boolean(indicator?.working);
    const isUnread = Boolean(indicator?.unread && currentRunId !== id);
    const needsUnreadApproval = isUnread && indicator.phase === "awaiting_approval";
    const isChosen = (loadingRunId ?? currentRunId) === id;
    const isLoadingThisRun = loadingRunId === id && currentRunId !== id;
    let displayLabel = `Graph ${id.slice(0, 8)}`;
    const labelText = runLabels[id];
    const isResolvingLabel = labelText === undefined;
    if (labelText) {
      displayLabel = labelText;
    }
    return (
      <RunItem
        // A provisional card keeps its key when the durable Run ID arrives so
        // the same node is reused instead of remounting.
        key={runCardKeys[id] ?? id}
        runId={id}
        index={index}
        reduceMotion={reduceMotion}
        skipEntrance={restoredRunKeys.has(runCardKeys[id] ?? id)}
        className={`${isChosen ? "chosen" : ""} ${isLoadingThisRun ? "is-loading" : ""}`}
        onClick={() => onLoadRun(id)}
        selected={isChosen}
        busy={isLoadingThisRun}
        menuOpen={runContextMenu?.runId === id}
        onContextMenu={(e) => {
          const anchor = contextMenuAnchor(e);
          if (!anchor) return;
          setProjectContextMenu(null);
          setRunContextMenu({
            ...anchor, runId: id,
            // The durable ID may replace a pending card while its menu is open.
            provisionalPrompt: id.startsWith("pending-") ? runLabels[id] : undefined,
          });
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
      </RunItem>
    );
  });

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

      <div className={`projects-list${projects.length === 1 ? " has-single-project" : ""}`} inert={isCollapsed}>
        {reduceMotion ? projectCards : <AnimatePresence>{projectCards}</AnimatePresence>}
        {projects.length === 0 && (
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

      <div className="runs-list" inert={isCollapsed}>
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
        ) : (
          <>
            {reduceMotion
              ? runCards
              : <AnimatePresence key={workspaceKey(activeRepo)}>{runCards}</AnimatePresence>}
            {runs.length === 0 && (
              <div className="run-placeholder">
                <span>{t("暂无对话记录")}</span>
              </div>
            )}
          </>
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

      {projectContextMenu && (
        <ContextMenu
          anchor={projectContextMenu}
          label={projectContextMenu.project.name}
          onClose={() => setProjectContextMenu(null)}
        >
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="context-menu-item"
            onClick={() => {
              onCancelPendingPromptCopy();
              navigator.clipboard?.writeText(normalizeWorkspacePath(projectContextMenu.project.path));
              setProjectContextMenu(null);
            }}
          >
            <Copy size={14} />
            <span>{t("复制仓库路径")}</span>
          </button>
          <div className="context-menu-divider" />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
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
        </ContextMenu>
      )}

      {runContextMenu && (
        <ContextMenu
          anchor={runContextMenu}
          label={runLabels[runContextMenu.runId] || `Graph ${runContextMenu.runId.slice(0, 8)}`}
          onClose={() => setRunContextMenu(null)}
        >
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="context-menu-item"
            onClick={() => {
              onCancelPendingPromptCopy();
              navigator.clipboard?.writeText(runContextMenu.runId);
              setRunContextMenu(null);
            }}
          >
            <Copy size={14} />
            <span>{t("复制快照 ID")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="context-menu-item"
            onClick={() => {
              const { runId, provisionalPrompt } = runContextMenu;
              setRunContextMenu(null);
              onCopyRunPrompt(runId, provisionalPrompt);
            }}
          >
            <Copy size={14} />
            <span>{t("复制提示词")}</span>
          </button>
          <div className="context-menu-divider" />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
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
        </ContextMenu>
      )}
    </aside>
  );
});

Sidebar.displayName = "Sidebar";
