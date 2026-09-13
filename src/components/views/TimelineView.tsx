import React, { useState, useMemo } from "react";
import { History, Clock3 } from "lucide-react";
import { GraphEvent } from "../../types";

interface TimelineViewProps {
  events: GraphEvent[];
}

export const TimelineView: React.FC<TimelineViewProps> = React.memo(({ events }) => {
  const [timelineFilter, setTimelineFilter] = useState<string>("all");

  const filteredEvents = useMemo(() => {
    return events
      .filter((event) => {
        if (event.type === "output") return false;
        if (timelineFilter === "all") return true;
        if (timelineFilter === "node") return ["started", "finished", "failed", "blocked", "prepared"].includes(event.type);
        if (timelineFilter === "feedback") return event.type === "feedback";
        if (timelineFilter === "intervention") return event.type === "invalidated" && event.human === true;
        if (timelineFilter === "approval") return ["approved", "rejected", "paused", "resumed"].includes(event.type);
        return true;
      })
      .slice()
      .reverse();
  }, [events, timelineFilter]);

  return (
    <section className="full-tab-view timeline-view">
      <div className="timeline-page-container">
        <div className="timeline-page-header">
          <div className="timeline-title-area">
            <History size={18} />
            <div>
              <h3>项目事件执行流水 (Audit Log)</h3>
              <small>确定性状态机按序记录的所有关键决策、依赖推进、代码提交与测试反馈。</small>
            </div>
          </div>
          <div className="timeline-filter-pills">
            {["all", "node", "feedback", "intervention", "approval"].map((f) => (
              <button
                type="button"
                key={f}
                className={`filter-pill ${timelineFilter === f ? "active" : ""}`}
                onClick={() => setTimelineFilter(f)}
              >
                {f === "all" ? "全部事件" : f === "node" ? "节点执行" : f === "feedback" ? "反馈复审" : f === "intervention" ? "人工介入" : "计划审批"}
              </button>
            ))}
          </div>
        </div>

        <div className="timeline-page-feed">
          {filteredEvents.length === 0 ? (
            <div className="timeline-empty-large">
              <Clock3 size={36} />
              <h4>暂无事件记录</h4>
              <p>当审批通过并开始推进节点时，事件流将实时按序显示在此处。</p>
            </div>
          ) : (
            filteredEvents.map((event) => (
              <div className="timeline-card" key={event.sequence}>
                <div className="card-seq">#{event.sequence}</div>
                <span className={`event-badge-dot ${event.type}`} />
                <div className="card-main">
                  <div className="card-title-row">
                    <strong>{event.type.replaceAll("_", " ").toUpperCase()}</strong>
                    <time>{new Date(event.timestamp).toLocaleString()}</time>
                  </div>
                  <p className="card-desc">
                    {event.node ? (
                      <>节点: <code>{event.node}</code></>
                    ) : event.execution?.node ? (
                      <>执行节点: <code>{event.execution.node}</code></>
                    ) : event.from ? (
                      <>{event.from} → {event.to}</>
                    ) : (
                      `执行事件 #${event.sequence}`
                    )}
                    {event.type === "feedback" && (
                      <span className={`feedback-tag ${event.accepted ? "accept" : "revise"}`}>
                        {event.accepted ? "✓ ACCEPTED" : "↻ REVISE REQUIRED"}
                      </span>
                    )}
                  </p>
                  {event.error && <div className="card-error">{event.error}</div>}
                  {event.instruction && (
                    <div className="card-instruction">
                      <span>介入指令:</span> {event.instruction}
                    </div>
                  )}
                  {event.execution && (
                    <div className="card-exec-meta">
                      <span>Worktree: <code>{event.execution.worktree}</code></span>
                      <span>Commit: <code>{event.execution.after || event.execution.before}</code></span>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
});

TimelineView.displayName = "TimelineView";
