import React, { useEffect, useId, useState } from "react";
import { AlertTriangle, Info, Loader2, Power, RefreshCw } from "lucide-react";
import { t } from "../i18n";
import {
  type AutostartController,
  type AutostartDriver,
  type AutostartErrorInfo,
} from "../services/autostart";
import { useAutostart } from "../hooks/useAutostart";

export function localizedAutostartErrorTitle(error: AutostartErrorInfo): string {
  if (error.kind === "unsupported") {
    return t("当前系统不支持登录时自动启动");
  }
  if (error.kind === "permission") {
    return t("没有权限修改系统登录启动项");
  }
  switch (error.phase) {
    case "read":
      return t("无法读取登录时自动启动状态");
    case "enable":
      return t("启用登录时自动启动失败");
    case "disable":
      return t("关闭登录时自动启动失败");
  }
}

export function localizedAutostartErrorBody(error: AutostartErrorInfo): string {
  if (error.kind === "unsupported") {
    return t("当前运行环境未提供可用的自动启动插件或系统接口，未更改系统启动项。");
  }
  if (error.kind === "permission") {
    return t("操作系统拒绝了登录启动项访问；请检查系统登录项权限或安全策略后重试。");
  }
  switch (error.phase) {
    case "read":
      return t("未能从操作系统读取当前登录启动项状态；请重试。");
    case "enable":
      return t("未能向操作系统注册登录启动项，开关已恢复为实际系统状态。");
    case "disable":
      return t("未能从操作系统移除登录启动项，开关已恢复为实际系统状态。");
  }
}

export interface AutostartSettingsProps {
  disabled?: boolean;
  active?: boolean;
  controller?: AutostartController;
  driver?: AutostartDriver;
}

/**
 * Delay showing the inline busy row and disabled visual state so fast local OS
 * reads/writes (~5–15ms) do not flash a spinner, shift layout/scroll position,
 * or blur the checkbox mid-click.
 */
const BUSY_FEEDBACK_DELAY_MS = 180;

export const AutostartSettings: React.FC<AutostartSettingsProps> = ({
  disabled = false,
  active = true,
  controller,
  driver,
}) => {
  const toggleId = useId();
  const descId = useId();
  const { snapshot, refresh, setEnabled } = useAutostart({
    controller,
    driver,
    active,
  });

  const busy = snapshot.loading || snapshot.updating;
  const [showBusyFeedback, setShowBusyFeedback] = useState(false);

  useEffect(() => {
    if (!busy) {
      setShowBusyFeedback(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setShowBusyFeedback(true);
    }, BUSY_FEEDBACK_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [busy]);

  const checked =
    snapshot.updating && snapshot.pendingTarget !== null
      ? snapshot.pendingTarget
      : snapshot.enabled;
  const toggleDisabled = disabled || !snapshot.loaded || (busy && showBusyFeedback);

  return (
    <section
      className="settings-card autostart-settings"
      aria-labelledby="autostart-settings-title"
    >
      <div className="settings-card-title">
        <Power size={16} aria-hidden="true" />
        <h4 id="autostart-settings-title">{t("桌面设置")}</h4>
      </div>

      {!snapshot.supported ? (
        <div className="update-settings-status-row autostart-settings-browser" role="status">
          <Info size={15} aria-hidden="true" />
          <div className="update-settings-status-body">
            <strong>{t("当前为浏览器模式")}</strong>
            <p>
              {t(
                "登录时自动启动仅在 Grapher 桌面端（macOS / Windows）中可用。浏览器模式不会修改系统启动项。",
              )}
            </p>
          </div>
        </div>
      ) : (
        <>
          <label
            className={`settings-toggle-row${toggleDisabled ? " is-disabled" : ""}`}
            htmlFor={toggleId}
          >
            <span>
              <strong>{t("登录时自动启动")}</strong>
              <small id={descId}>
                {t(
                  "登录当前用户账户时自动启动 Grapher（仅当前用户生效，不安装提权系统服务；更改立即生效）。",
                )}
              </small>
            </span>
            <input
              id={toggleId}
              type="checkbox"
              checked={checked}
              disabled={toggleDisabled}
              aria-describedby={descId}
              aria-busy={busy || undefined}
              data-testid="autostart-toggle"
              onChange={(event) => {
                if (busy) return;
                void setEnabled(event.target.checked);
              }}
            />
          </label>

          {busy && showBusyFeedback && (
            <div className="autostart-settings-status" role="status">
              <Loader2 size={14} className="update-settings-spin" aria-hidden="true" />
              <span>
                {snapshot.loading
                  ? t("正在读取系统登录启动状态…")
                  : snapshot.pendingTarget
                    ? t("正在启用登录时自动启动…")
                    : t("正在关闭登录时自动启动…")}
              </span>
            </div>
          )}

          {snapshot.error && (
            <div
              className={`update-settings-status-row autostart-settings-alert ${
                snapshot.error.kind === "unsupported" ? "is-warning" : "is-error"
              }`}
              role="alert"
            >
              {snapshot.error.kind === "unsupported" ? (
                <Info size={15} aria-hidden="true" />
              ) : (
                <AlertTriangle size={15} aria-hidden="true" />
              )}
              <div className="update-settings-status-body">
                <strong>{localizedAutostartErrorTitle(snapshot.error)}</strong>
                <p>{localizedAutostartErrorBody(snapshot.error)}</p>
                <p className="update-settings-error-detail">{snapshot.error.rawMessage}</p>
                {snapshot.error.phase === "read" && (
                  <div className="update-settings-actions">
                    <button
                      type="button"
                      className="update-settings-secondary-btn"
                      disabled={disabled || busy}
                      onClick={() => void refresh()}
                    >
                      <RefreshCw size={13} aria-hidden="true" />
                      <span>{t("重试")}</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
};

AutostartSettings.displayName = "AutostartSettings";
