import { t } from "../../i18n";
import React, { useState } from "react";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import { Plus, Settings2, Trash2, Copy, PanelLeftClose, PanelLeftOpen, Loader2 } from "lucide-react";
import type { ProjectItem } from "../../types";
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

type CardEntranceMode = "none" | "expand" | "placeholder" | "fade" | "stagger";

// Matches the CSS overlay breakpoint below which the sidebar would otherwise
// take a large share of the width from the single-pane workbench.
const NARROW_SIDEBAR_QUERY = "(max-width: 720px)";

function startsCollapsed(): boolean {
  return typeof window !== "undefined" && window.matchMedia(NARROW_SIDEBAR_QUERY).matches;
}

function cardMotion(reduceMotion: boolean, listGap = 0) {
  if (reduceMotion) {
    return {
      initial: false as const,
      animate: { opacity: 1, y: 0 },
      exit: { opacity: 0 },
    };
  }
  return {
    initial: false as const,
    exit: listGap > 0 ? PROJECT_CARD_EXIT : RUN_CARD_EXIT,
  };
}

/**
 * Animate card entrance via WAAPI using the card's settled CSS box so newly
 * inserted cards open their vertical space smoothly (avoiding a 1-frame jump
 * of cards below, an empty-slot flash, or a transient scrollbar overflow) and
 * leave zero inline style overrides once finished.
 */
function useCardEntrance(
  ref: React.RefObject<HTMLButtonElement | null>,
  mode: CardEntranceMode,
  index: number,
  reduceMotion: boolean,
  listGap = 0,
  placeholderHeight?: number,
) {
  const isPresent = useIsPresent();
  const initialModeRef = React.useRef(mode);
  const initialIndexRef = React.useRef(index);
  const initialGapRef = React.useRef(listGap);
  const initialPlaceholderHeightRef = React.useRef(placeholderHeight);
  const animationsRef = React.useRef<Animation[]>([]);

  React.useLayoutEffect(() => {
    const el = ref.current;
    const entrance = initialModeRef.current;
    if (reduceMotion || entrance === "none" || !el || typeof el.animate !== "function") return;

    const animations: Animation[] = [];
    if (entrance === "stagger") {
      const anim = el.animate(
        [
          { opacity: 0 },
          { opacity: 1 },
        ],
        {
          duration: 200,
          delay: Math.min(initialIndexRef.current, 6) * 18,
          easing: "cubic-bezier(0.16, 1, 0.3, 1)",
          fill: "backwards",
        },
      );
      animations.push(anim);
    } else if (entrance === "fade") {
      const anim = el.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        {
          duration: 180,
          easing: "cubic-bezier(0.16, 1, 0.3, 1)",
          fill: "backwards",
        },
      );
      animations.push(anim);
    } else {
      const cs = getComputedStyle(el);
      const targetHeight = el.getBoundingClientRect().height;
      const targetMinHeight = parseFloat(cs.minHeight) || 0;
      const targetPadTop = parseFloat(cs.paddingTop) || 0;
      const targetPadBottom = parseFloat(cs.paddingBottom) || 0;
      const targetBorderTop = parseFloat(cs.borderTopWidth) || 0;
      const targetBorderBottom = parseFloat(cs.borderBottomWidth) || 0;
      const targetMarginBottom = parseFloat(cs.marginBottom) || 0;
      const gap = initialGapRef.current;
      const fromPlaceholder = entrance === "placeholder";
      const startHeight = fromPlaceholder
        ? Math.min(initialPlaceholderHeightRef.current ?? targetHeight, targetHeight)
        : 0;

      el.style.overflow = "hidden";
      const boxAnim = el.animate(
        [
          fromPlaceholder
            ? {
                height: `${startHeight}px`,
                minHeight: "0px",
              }
            : {
                height: "0px",
                minHeight: "0px",
                paddingTop: "0px",
                paddingBottom: "0px",
                borderTopWidth: "0px",
                borderBottomWidth: "0px",
                marginBottom: `${gap > 0 ? -gap : 0}px`,
              },
          {
            height: `${targetHeight}px`,
            minHeight: `${targetMinHeight}px`,
            paddingTop: `${targetPadTop}px`,
            paddingBottom: `${targetPadBottom}px`,
            borderTopWidth: `${targetBorderTop}px`,
            borderBottomWidth: `${targetBorderBottom}px`,
            marginBottom: `${targetMarginBottom}px`,
          },
        ],
        {
          duration: fromPlaceholder ? 200 : 220,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        },
      );
      const clearOverflow = () => {
        if (el.style.overflow === "hidden") el.style.overflow = "";
      };
      boxAnim.onfinish = clearOverflow;
      boxAnim.oncancel = clearOverflow;

      const opacityAnim = el.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        {
          duration: 160,
          delay: fromPlaceholder ? 20 : 45,
          easing: "cubic-bezier(0.16, 1, 0.3, 1)",
          fill: "backwards",
        },
      );
      animations.push(boxAnim, opacityAnim);
    }

    animationsRef.current = animations;
    return () => {
      for (const anim of animations) anim.cancel();
      animationsRef.current = [];
      if (el.style.overflow === "hidden") el.style.overflow = "";
    };
  }, [reduceMotion, ref]);

  React.useLayoutEffect(() => {
    if (isPresent) return;
    const el = ref.current;
    const animations = animationsRef.current;
    if (!el || animations.length === 0) return;
    for (const anim of animations) {
      if (anim.playState === "running") {
        try {
          if (el.isConnected) anim.commitStyles();
        } catch {
          // Ignore commit errors if the element is detached before exit settles.
        }
      }
      anim.cancel();
    }
    animationsRef.current = [];
    if (el.style.overflow === "hidden") el.style.overflow = "";
  }, [isPresent, ref]);
}

const WorkspaceItem: React.FC<{
  project: ProjectItem;
  index: number;
  reduceMotion: boolean;
  entranceMode: CardEntranceMode;
  placeholderHeight?: number;
  isActive: boolean;
  isSwitching: boolean;
  menuOpen: boolean;
  onClick: () => void;
  onContextMenu: (event: React.MouseEvent<HTMLButtonElement> | React.KeyboardEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
}> = ({
  project,
  index,
  reduceMotion,
  entranceMode,
  placeholderHeight,
  isActive,
  isSwitching,
  menuOpen,
  onClick,
  onContextMenu,
  children,
}) => {
  const ref = React.useRef<HTMLButtonElement | null>(null);
  useCardEntrance(ref, entranceMode, index, reduceMotion, PROJECT_LIST_GAP, placeholderHeight);
  return (
    <motion.button
      ref={ref}
      type="button"
      aria-label={`${project.name}\n${normalizeWorkspacePath(project.path)}`}
      aria-current={isActive ? "true" : undefined}
      aria-busy={isSwitching}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      className={`project-workspace-item ${isActive ? "active" : ""} ${isSwitching ? "is-switching" : ""}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={onContextMenu}
      {...cardMotion(reduceMotion, PROJECT_LIST_GAP)}
    >
      {children}
    </motion.button>
  );
};

/**
 * Conversation card. The caller keys it by a stable card key so adopting a
 * durable Run ID after the provisional card reuses the same node instead of
 * remounting it (which would replay the entrance and exit animations).
 */
const RunItem: React.FC<{
  runId: string;
  index: number;
  reduceMotion: boolean;
  entranceMode: CardEntranceMode;
  className?: string;
  onClick: () => void;
  onContextMenu: (event: React.MouseEvent<HTMLButtonElement> | React.KeyboardEvent<HTMLButtonElement>) => void;
  selected: boolean;
  busy: boolean;
  menuOpen: boolean;
  children: React.ReactNode;
}> = ({ runId, index, reduceMotion, entranceMode, className = "", onClick, onContextMenu, selected, busy, menuOpen, children }) => {
  const ref = React.useRef<HTMLButtonElement | null>(null);
  useCardEntrance(ref, entranceMode, index, reduceMotion, 0);
  return (
    <motion.button
      ref={ref}
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
      {...cardMotion(reduceMotion)}
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
  hasUpdateAvailable?: boolean;
  runLabels?: Record<string, string>;
  runCardKeys?: Record<string, string>;
  initialRunIds?: readonly string[];
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
  hasUpdateAvailable = false,
  runLabels = {},
  runCardKeys = {},
  initialRunIds = [],
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
  const [projectExitActive, setProjectExitActive] = useState(false);
  const projectsPlaceholderRef = React.useRef<HTMLDivElement | null>(null);
  const projectsPlaceholderHeightRef = React.useRef<number>(34);
  const previousProjectKeysRef = React.useRef(new Set(projects.map(project => workspaceKey(project.path))));
  const activeRepoKey = workspaceKey(activeRepo);
  const previousRunsStateRef = React.useRef({
    activeRepo: activeRepoKey,
    wasReady: isReady,
    keys: new Set(isReady ? runs.map(id => runCardKeys[id] ?? id) : []),
  });
  // The caller may remember current cache IDs solely for motion. Cards still
  // render only from the authoritative runs prop after bootstrap.
  const restoredKeysRef = React.useRef<{ projects: Set<string>; runs: Set<string> } | null>(null);
  if (restoredKeysRef.current === null) {
    restoredKeysRef.current = {
      projects: new Set(projects.map(proj => workspaceKey(proj.path))),
      runs: new Set([...initialRunIds, ...(isReady ? runs : [])].map(id => runCardKeys[id] ?? id)),
    };
  }
  const restoredProjectKeys = restoredKeysRef.current.projects;
  const restoredRunKeys = restoredKeysRef.current.runs;

  React.useLayoutEffect(() => {
    const nextKeys = new Set(projects.map(project => workspaceKey(project.path)));
    const removed = [...previousProjectKeysRef.current].some(key => !nextKeys.has(key));
    if (!reduceMotion && removed) setProjectExitActive(true);
    for (const key of previousProjectKeysRef.current) {
      if (!nextKeys.has(key)) restoredProjectKeys.delete(key);
    }
    if (projects.length === 0 && projectsPlaceholderRef.current) {
      const measured = projectsPlaceholderRef.current.getBoundingClientRect().height;
      if (measured > 0) projectsPlaceholderHeightRef.current = measured;
    }
    previousProjectKeysRef.current = nextKeys;
  }, [projects, reduceMotion, restoredProjectKeys]);

  React.useLayoutEffect(() => {
    const nextKeys = new Set(isReady ? runs.map(id => runCardKeys[id] ?? id) : []);
    const prev = previousRunsStateRef.current;
    if (isReady && prev.wasReady && prev.activeRepo === activeRepoKey) {
      for (const key of prev.keys) {
        if (!nextKeys.has(key)) restoredRunKeys.delete(key);
      }
    }
    previousRunsStateRef.current = {
      activeRepo: activeRepoKey,
      wasReady: isReady,
      keys: nextKeys,
    };
  }, [activeRepoKey, isReady, runs, runCardKeys, restoredRunKeys]);

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

  const prevProjectKeys = previousProjectKeysRef.current;
  const projectCards = projects.map((proj, index) => {
    const key = workspaceKey(proj.path);
    const isActive = activeRepoKey === key;
    const isSwitching = switchingProjectPath ? workspaceKey(switchingProjectPath) === key : false;
    const isNewProject = !restoredProjectKeys.has(key) && !prevProjectKeys.has(key);
    let entranceMode: CardEntranceMode = "none";
    if (!reduceMotion && isNewProject) {
      if (prevProjectKeys.size > 0) entranceMode = "expand";
      else if (projects.length === 1) entranceMode = "placeholder";
      else entranceMode = "stagger";
    }
    const openMenu = (event: React.MouseEvent<HTMLButtonElement> | React.KeyboardEvent<HTMLButtonElement>) => {
      const anchor = contextMenuAnchor(event);
      if (!anchor) return;
      setRunContextMenu(null);
      setProjectContextMenu({ ...anchor, project: proj });
    };
    return (
      <WorkspaceItem
        key={key}
        project={proj}
        index={index}
        reduceMotion={reduceMotion}
        entranceMode={entranceMode}
        placeholderHeight={projectsPlaceholderHeightRef.current}
        isActive={isActive}
        isSwitching={isSwitching}
        menuOpen={projectContextMenu?.project.path === proj.path}
        onClick={() => onSelectProject(proj)}
        onContextMenu={openMenu}
      >
        <span className="proj-details">
          <span className="proj-name-row">
            <strong>{proj.name}</strong>
          </span>
          <small className="proj-path-text">{workspacePathDisplay(proj.path)}</small>
        </span>
      </WorkspaceItem>
    );
  });

  const prevRunsState = previousRunsStateRef.current;
  const runCards = runs.map((id, index) => {
    const cardKey = runCardKeys[id] ?? id;
    const isRestored = restoredRunKeys.has(cardKey);
    const isNewRun = isReady && !isRestored &&
      (prevRunsState.activeRepo !== activeRepoKey || !prevRunsState.wasReady || !prevRunsState.keys.has(cardKey));
    let entranceMode: CardEntranceMode = "none";
    if (!reduceMotion && isNewRun) {
      if (prevRunsState.wasReady && prevRunsState.activeRepo === activeRepoKey) {
        if (prevRunsState.keys.size > 0) entranceMode = "expand";
        else if (runs.length === 1) entranceMode = "fade";
        else entranceMode = "stagger";
      } else {
        entranceMode = "stagger";
      }
    }
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
        key={cardKey}
        runId={id}
        index={index}
        reduceMotion={reduceMotion}
        entranceMode={entranceMode}
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

      <div className={`projects-list${projectExitActive ? " is-removing" : ""}`} inert={isCollapsed}>
        {reduceMotion ? projectCards : <AnimatePresence onExitComplete={() => setProjectExitActive(false)}>{projectCards}</AnimatePresence>}
        {projects.length === 0 && (
          <div ref={projectsPlaceholderRef} className="projects-placeholder">
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
          {hasUpdateAvailable && (
            <i className="sidebar-update-dot" aria-hidden="true" title={t("发现新版本")} />
          )}
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
              void navigator.clipboard?.writeText(normalizeWorkspacePath(projectContextMenu.project.path)).catch(() => {});
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
              void navigator.clipboard?.writeText(runContextMenu.runId).catch(() => {});
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
