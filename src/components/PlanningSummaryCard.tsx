import React, { useState, useEffect, useMemo } from "react";
import {
  Clock, Cpu, AlertTriangle, AlertCircle, ChevronDown, ChevronUp,
  Copy, Check, FileText, CheckCircle2, PauseCircle, Wrench
} from "lucide-react";
import type { PlanningSummary, PlanningRoleMetrics, Snapshot, TokenUsage } from "../types";
import { PlanningActivity } from "./PlanningActivity";

interface PlanningSummaryCardProps {
  planning: PlanningSummary;
  state?: Snapshot;
  defaultExpanded?: boolean;
}

export function formatSeconds(seconds: number): string {
  if (seconds == null || isNaN(seconds) || seconds < 0) return "0s";
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  const totalSecs = Math.floor(seconds);
  const minutes = Math.floor(totalSecs / 60);
  const remainingSecs = totalSecs % 60;
  if (minutes === 0) return `${seconds.toFixed(1)}s`;
  return `${minutes}分${remainingSecs}秒`;
}

export function formatNumber(num?: number): string {
  if (num == null) return "0";
  return num.toLocaleString();
}

export function parseTimestamp(val: unknown): number {
  if (val == null) return 0;
  if (typeof val === "number") return val > 0 ? val : 0;
  if (typeof val === "string") {
    const trimmed = val.trim();
    const num = Number(trimmed);
    if (!isNaN(num) && num > 100000000000) return num;
    const parsed = new Date(trimmed).getTime();
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

export function getPlanningCompletedAt(planning: PlanningSummary, state?: Snapshot): number {
  if (state?.events) {
    const created = state.events.find((e) => e.type === "created");
    if (created && created.timestamp > 0) return created.timestamp;
  }
  const plannerRole = planning.roles?.planner;
  if (plannerRole?.lastEvent) {
    const t = parseTimestamp(plannerRole.lastEvent);
    if (t > 0) return t;
  }
  const partitionRole = planning.roles?.partition;
  if (partitionRole?.lastEvent) {
    const t = parseTimestamp(partitionRole.lastEvent);
    if (t > 0) return t;
  }
  return 0;
}

export function calculateApprovalWaitingTime(
  planning: PlanningSummary,
  state?: Snapshot,
  now: number = Date.now()
): { durationSeconds: number; isWaiting: boolean } {
  if (!state) return { durationSeconds: 0, isWaiting: false };
  const completedAt = getPlanningCompletedAt(planning, state);
  const approvedEvent = state.events?.find((e) => e.type === "approved");
  if (approvedEvent && completedAt > 0) {
    const duration = Math.max(0, (approvedEvent.timestamp - completedAt) / 1000);
    return { durationSeconds: duration, isWaiting: false };
  }
  if (!state.approved && completedAt > 0) {
    const duration = Math.max(0, (now - completedAt) / 1000);
    return { durationSeconds: duration, isWaiting: true };
  }
  return { durationSeconds: 0, isWaiting: false };
}

export function calculatePausedTime(state?: Snapshot, now: number = Date.now()): number {
  if (!state || !state.events) return 0;
  let totalPausedMs = 0;
  let pauseStart: number | null = null;
  for (const ev of state.events) {
    if (ev.type === "paused") {
      const isPaused = (ev as any).paused !== false;
      if (isPaused && pauseStart == null) {
        pauseStart = ev.timestamp;
      } else if (!isPaused && pauseStart != null) {
        totalPausedMs += Math.max(0, ev.timestamp - pauseStart);
        pauseStart = null;
      }
    }
  }
  if (pauseStart != null) {
    totalPausedMs += Math.max(0, now - pauseStart);
  }
  return totalPausedMs / 1000;
}

export const PlanningSummaryCard: React.FC<PlanningSummaryCardProps> = ({
  planning,
  state,
  defaultExpanded = false,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now);

  const approvalWaiting = useMemo(
    () => calculateApprovalWaitingTime(planning, state, now),
    [planning, state, now]
  );

  const pausedSeconds = useMemo(
    () => calculatePausedTime(state, now),
    [state, now]
  );

  const needsClock = approvalWaiting.isWaiting || !!state?.paused;
  useEffect(() => {
    if (!needsClock) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [needsClock]);

  const handleCopyId = () => {
    if (!planning.planningId) return;
    navigator.clipboard.writeText(planning.planningId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const rolesList = useMemo(() => {
    return Object.entries(planning.roles || {});
  }, [planning.roles]);

  const totalToolCalls = useMemo(() => {
    return rolesList.reduce((acc, [, r]) => acc + (r.tools || 0), 0);
  }, [rolesList]);

  const totalToolErrors = useMemo(() => {
    return rolesList.reduce((acc, [, r]) => acc + (r.toolErrors || 0), 0);
  }, [rolesList]);

  const totalUsage = useMemo(() => {
    const sum: TokenUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 0,
    };
    for (const [, r] of rolesList) {
      if (r.usage) {
        sum.input += r.usage.input || 0;
        sum.output += r.usage.output || 0;
        sum.cacheRead += r.usage.cacheRead || 0;
        sum.cacheWrite += r.usage.cacheWrite || 0;
        sum.reasoning += r.usage.reasoning || 0;
        sum.totalTokens += r.usage.totalTokens || 0;
      }
    }
    return sum;
  }, [rolesList]);

  const primaryModel =
    planning.roles?.planner?.model ||
    planning.roles?.partition?.model ||
    rolesList[0]?.[1]?.model ||
    "default-model";

  return (
    <div className="planning-summary-card" data-testid="planning-summary-card">
      <div className="planning-summary-header">
        <div className="planning-summary-title-area">
          <Cpu size={15} className="planning-icon" />
          <span className="planning-summary-title">规划阶段摘要</span>
          <span className="planning-model-badge" title="规划使用模型">
            {primaryModel}
          </span>
        </div>
        <div className="planning-summary-actions">
          <button
            type="button"
            className="planning-id-chip"
            onClick={handleCopyId}
            title={`点击复制规划 ID: ${planning.planningId}`}
          >
            <span className="id-label">ID:</span>
            <span className="id-val">{planning.planningId.slice(0, 8)}...</span>
            {copied ? <Check size={12} className="copied-icon" /> : <Copy size={12} />}
          </button>
          <button
            type="button"
            className="planning-toggle-btn"
            onClick={() => setExpanded(!expanded)}
            title={expanded ? "收起明细" : "展开明细"}
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>

      {/* 规划失败提示 */}
      {(planning.error || planning.status === "failed") && (
        <div className="planning-error-notice" style={{ marginBottom: 10, padding: "8px 12px", background: "rgba(239, 68, 68, 0.1)", borderRadius: 6, color: "#ef4444", fontSize: 11, display: "flex", alignItems: "flex-start", gap: 6, border: "1px solid rgba(239, 68, 68, 0.2)" }}>
          <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>规划未通过：{planning.error || "规划阶段异常中断"}</span>
        </div>
      )}

      {/* 关键时耗与资源统计网格 */}
      <div className="planning-stats-grid">
        <div className="planning-stat-box" title="分片器与规划器的 Pi 会话总时长（涵盖模型推理、工具交互与沙箱执行）">
          <span className="stat-label">
            <Cpu size={12} />
            Pi 会话耗时
          </span>
          <span className="stat-value planning-duration">{formatSeconds(planning.modelDuration)}</span>
        </div>

        <div className="planning-stat-box" title={planning.status === "failed" || planning.error ? "规划状态" : "规划创建至用户点击审批的等待耗时"}>
          <span className="stat-label">
            {planning.status === "failed" || planning.error ? <AlertCircle size={12} /> : <Clock size={12} />}
            {planning.status === "failed" || planning.error ? "规划状态" : "审批等待"}
          </span>
          <span className={`stat-value ${planning.status === "failed" || planning.error ? "error" : approvalWaiting.isWaiting ? "warning" : "neutral"}`}>
            {planning.status === "failed" || planning.error ? (
              <span style={{ color: "#ef4444" }}>未通过</span>
            ) : (
              <>
                {formatSeconds(approvalWaiting.durationSeconds)}
                {approvalWaiting.isWaiting && <span className="waiting-pill">等待中</span>}
              </>
            )}
          </span>
        </div>

        <div className="planning-stat-box" title="规划阶段总时长（开始到完成）">
          <span className="stat-label">
            <CheckCircle2 size={12} />
            规划耗时
          </span>
          <span className="stat-value neutral">{formatSeconds(planning.totalPlanningDuration)}</span>
        </div>

        <div className="planning-stat-box" title="规划过程中工具调用总数与失败数">
          <span className="stat-label">
            <Wrench size={12} />
            工具调用
          </span>
          <span className="stat-value neutral">
            {totalToolCalls}
            {totalToolErrors > 0 ? (
              <span className="tool-errors-tag" title={`${totalToolErrors} 次工具执行报错`}>
                <AlertTriangle size={10} />
                {totalToolErrors} 错
              </span>
            ) : null}
          </span>
        </div>
      </div>

      {/* 暂停时间（若发生过暂停） */}
      {pausedSeconds > 0 && (
        <div className="planning-pause-notice">
          <PauseCircle size={12} />
          <span>执行暂停耗时：{formatSeconds(pausedSeconds)}</span>
        </div>
      )}

      {/* 展开的 Token 使用明细与角色指标 */}
      {expanded && (
        <div className="planning-expanded-content">
          {/* Token 使用概览 */}
          {totalUsage.totalTokens > 0 && (
            <div className="planning-token-section">
              <div className="section-title">Token 资源消耗</div>
              <div className="token-metrics-row">
                <div className="token-item">
                  <span className="token-lbl">输入 (Input)</span>
                  <span className="token-num">{formatNumber(totalUsage.input)}</span>
                </div>
                <div className="token-item">
                  <span className="token-lbl">输出 (Output)</span>
                  <span className="token-num">{formatNumber(totalUsage.output)}</span>
                </div>
                {totalUsage.cacheRead > 0 && (
                  <div className="token-item">
                    <span className="token-lbl">缓存读取 (Cache)</span>
                    <span className="token-num">{formatNumber(totalUsage.cacheRead)}</span>
                  </div>
                )}
                {totalUsage.reasoning > 0 && (
                  <div className="token-item">
                    <span className="token-lbl">思考 (Reasoning)</span>
                    <span className="token-num">{formatNumber(totalUsage.reasoning)}</span>
                  </div>
                )}
                <div className="token-item total">
                  <span className="token-lbl">总计 (Total)</span>
                  <span className="token-num">{formatNumber(totalUsage.totalTokens)}</span>
                </div>
              </div>
            </div>
          )}

          {/* 分角色明细 (Partitioner / Planner) */}
          <div className="planning-roles-section">
            <div className="section-title">分阶段角色指标</div>
            <div className="roles-grid">
              {rolesList.map(([roleKey, role]) => {
                const roleDisplayName =
                  roleKey === "partition"
                    ? "任务分片器 (Partitioner)"
                    : roleKey === "planner"
                    ? "拓扑规划器 (Planner)"
                    : roleKey;
                return (
                  <div key={roleKey} className="role-metric-card">
                    <div className="role-metric-header">
                      <strong>{roleDisplayName}</strong>
                      <span className="role-duration">{formatSeconds(role.durationSeconds)}</span>
                    </div>
                    <div className="role-stats-list">
                      <div className="role-stat-line">
                        <span>工具调用:</span>
                        <span>
                          {role.tools} 次
                          {role.toolErrors > 0 && (
                            <span className="error-count-inline"> ({role.toolErrors} 错误)</span>
                          )}
                        </span>
                      </div>
                      <div className="role-stat-line">
                        <span>消息轮次:</span>
                        <span>{role.assistantMessages} 轮</span>
                      </div>
                      {role.usage && (
                        <div className="role-stat-line">
                          <span>Token:</span>
                          <span>{formatNumber(role.usage.totalTokens)}</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="planning-footer-note">
            <FileText size={11} />
            <span>
              统计摘要与完整规划活动分别保存；下方可查看规划时的文字、思维链及工具调用。
            </span>
          </div>
        </div>
      )}
      <PlanningActivity key={planning.planningId} planning={planning} />
    </div>
  );
};
