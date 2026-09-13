import React from "react";
import { FolderGit2, GitBranch, ChevronRight, GitFork, MessageSquare, History } from "lucide-react";
import { motion } from "motion/react";
import { ProjectItem, RepositoryInfo, Config } from "../../types";
import { phaseText } from "../graph/TaskNode";

interface HeaderProps {
  activeProject?: ProjectItem;
  repoInfo: RepositoryInfo | null;
  config: Config;
  phase: string;
  mainTab: "graph" | "sessions" | "timeline";
  setMainTab: (tab: "graph" | "sessions" | "timeline") => void;
  nodesCount: number;
  eventsCount: number;
}

export const Header: React.FC<HeaderProps> = React.memo(({
  activeProject,
  repoInfo,
  config,
  phase,
  mainTab,
  setMainTab,
  nodesCount,
  eventsCount,
}) => {
  return (
    <motion.header
      className="workspace-header"
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="header-top">
        <div className="workspace-meta">
          <FolderGit2 size={16} />
          <span className="repo-badge" title={config.repository || "未选择本地仓库"}>
            {activeProject?.name || repoInfo?.name || (config.repository ? config.repository.split("/").pop() : "未选择项目")}
          </span>
          {activeProject?.isShadow || repoInfo?.isShadow ? (
            <span className="shadow-tag" title="本地零侵入影子仓库：版本由 Grapher 内部维护，不污染用户目录">
              影子仓库
            </span>
          ) : activeProject?.branch ? (
            <span className="branch-tag">
              <GitBranch size={11} />
              {activeProject.branch}
            </span>
          ) : null}
          <ChevronRight size={13} />
          <span className={`phase-tag ${phase}`}>{phaseText[phase] ?? "草稿"}</span>
        </div>

        <nav className="header-nav-tabs">
          <button
            type="button"
            className={`tab-btn ${mainTab === "graph" ? "active" : ""}`}
            onClick={() => setMainTab("graph")}
          >
            {mainTab === "graph" && (
              <motion.div
                layoutId="header-active-tab-pill"
                className="tab-active-indicator"
                transition={{ type: "spring", stiffness: 420, damping: 32 }}
              />
            )}
            <GitFork size={14} />
            <span>执行拓扑图</span>
            {nodesCount > 0 && <span className="tab-count">{nodesCount}</span>}
          </button>
          <button
            type="button"
            className={`tab-btn ${mainTab === "sessions" ? "active" : ""}`}
            onClick={() => setMainTab("sessions")}
          >
            {mainTab === "sessions" && (
              <motion.div
                layoutId="header-active-tab-pill"
                className="tab-active-indicator"
                transition={{ type: "spring", stiffness: 420, damping: 32 }}
              />
            )}
            <MessageSquare size={14} />
            <span>节点会话与日志</span>
          </button>
          <button
            type="button"
            className={`tab-btn ${mainTab === "timeline" ? "active" : ""}`}
            onClick={() => setMainTab("timeline")}
          >
            {mainTab === "timeline" && (
              <motion.div
                layoutId="header-active-tab-pill"
                className="tab-active-indicator"
                transition={{ type: "spring", stiffness: 420, damping: 32 }}
              />
            )}
            <History size={14} />
            <span>事件流水</span>
            <span className="tab-count">{eventsCount}</span>
          </button>
        </nav>

        <div className="header-actions" />
      </div>
    </motion.header>
  );
});

Header.displayName = "Header";
