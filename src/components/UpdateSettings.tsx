import React from "react";
import {
  AlertTriangle,
  ArrowUpCircle,
  CheckCircle2,
  Download,
  Info,
  Loader2,
  RefreshCw,
  RotateCw,
  X,
} from "lucide-react";
import { t, locale } from "../i18n";
import {
  formatUpdaterBytes,
  UPDATER_RELEASES_URL,
  type AppUpdaterController,
  type UpdaterErrorInfo,
} from "../services/updater";
import { useAppUpdater } from "../hooks/useAppUpdater";

function formatVersion(version: string | null | undefined): string {
  if (!version) return "";
  return version.startsWith("v") ? version : `v${version}`;
}

function formatDate(isoDate: string | null): string | null {
  if (!isoDate) return null;
  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) return isoDate;
  try {
    return new Intl.DateTimeFormat(locale === "zh-CN" ? "zh-CN" : "en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(parsed);
  } catch {
    return isoDate;
  }
}

function formatTimestamp(ms: number | null): string | null {
  if (!ms) return null;
  try {
    return new Intl.DateTimeFormat(locale === "zh-CN" ? "zh-CN" : "en-US", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ms));
  } catch {
    return null;
  }
}

export function localizedUpdaterErrorTitle(error: UpdaterErrorInfo): string {
  switch (error.kind) {
    case "unsigned-unavailable":
      return t("当前平台暂无可安装的签名更新包");
    case "signature":
      return t("更新包签名校验失败");
    case "network":
      return t("无法连接更新服务器");
    case "install":
      return t("安装更新失败");
    case "restart":
      return t("自动重启失败");
    default:
      return error.phase === "download"
        ? t("下载更新失败")
        : t("检查更新失败");
  }
}

export function localizedUpdaterErrorBody(error: UpdaterErrorInfo): string {
  switch (error.kind) {
    case "unsigned-unavailable":
      return t(
        "未签名的 CI 或本地构建不包含可验证的签名更新包，应用启动和正常使用不受影响；您可以前往 GitHub Releases 手动下载安装包。",
      );
    case "signature":
      return t(
        "未能通过内置公钥验证该更新包的签名（或当前构建未配置发布签名公钥），出于安全原因已中止安装。",
      );
    case "network":
      return t("请检查网络连接后重试。");
    case "install":
      return t("未能完成更新包安装，请重试或前往 GitHub Releases 手动更新。");
    case "restart":
      return t("更新已安装，请手动重启 Grapher 以启用新版本。");
    default:
      return t("请稍后重试，或前往 GitHub Releases 手动下载最新版本。");
  }
}

export interface UpdateSettingsProps {
  disabled?: boolean;
  controller?: AppUpdaterController;
}

export const UpdateSettings: React.FC<UpdateSettingsProps> = ({
  disabled = false,
  controller,
}) => {
  const {
    snapshot,
    checkForUpdates,
    installAndRestart,
    cancelDownload,
    retry,
    restartApp,
  } = useAppUpdater({ controller });

  const busy =
    snapshot.status === "checking" ||
    snapshot.status === "downloading" ||
    snapshot.status === "cancelling" ||
    snapshot.status === "installing" ||
    snapshot.status === "restarting";

  const versionText = formatVersion(
    snapshot.currentVersion ?? snapshot.availableUpdate?.currentVersion,
  );
  const checkedTime = formatTimestamp(snapshot.lastCheckedAt);
  const update = snapshot.availableUpdate;
  const formattedDate = formatDate(update?.date ?? null);
  const progress = snapshot.progress;

  return (
    <section className="settings-card update-settings" aria-labelledby="update-settings-title">
      <div className="settings-card-title">
        <ArrowUpCircle size={16} aria-hidden="true" />
        <h4 id="update-settings-title">{t("应用更新")}</h4>
        {versionText && (
          <span className="update-settings-version-pill" data-testid="updater-current-version">
            {versionText}
          </span>
        )}
        {snapshot.supported && (
          <button
            type="button"
            className="update-settings-check-btn"
            disabled={disabled || busy}
            onClick={() => void checkForUpdates({ silent: false })}
          >
            <RefreshCw
              size={13}
              aria-hidden="true"
              className={snapshot.status === "checking" ? "update-settings-spin" : undefined}
            />
            <span>{snapshot.status === "checking" ? t("正在检查…") : t("检查更新")}</span>
          </button>
        )}
      </div>

      {!snapshot.supported ? (
        <div className="update-settings-status-row" role="status">
          <Info size={15} aria-hidden="true" />
          <div className="update-settings-status-body">
            <strong>{t("当前为浏览器模式")}</strong>
            <p>
              {t(
                "应用内自动更新仅在 Grapher 桌面端中可用。浏览器模式请拉取新版本，或前往 GitHub Releases 下载桌面安装包。",
              )}
            </p>
          </div>
        </div>
      ) : (
        <>
          {snapshot.status === "checking" && (
            <div className="update-settings-status-row" role="status">
              <Loader2 size={15} className="update-settings-spin" aria-hidden="true" />
              <div className="update-settings-status-body">
                <p>{t("正在检查 GitHub Releases 中的最新签名版本…")}</p>
              </div>
            </div>
          )}

          {snapshot.status === "up-to-date" && (
            <div className="update-settings-status-row is-success" role="status">
              <CheckCircle2 size={15} aria-hidden="true" />
              <div className="update-settings-status-body">
                <strong>
                  {versionText
                    ? t("当前已是最新版本（{0}）", versionText)
                    : t("当前已是最新版本")}
                </strong>
                {checkedTime && <p>{t("上次检查：{0}", checkedTime)}</p>}
              </div>
            </div>
          )}

          {snapshot.status === "ready-to-restart" && (
            <div className="update-settings-status-row is-success" role="status">
              <CheckCircle2 size={15} aria-hidden="true" />
              <div className="update-settings-status-body">
                <strong>{t("更新已安装，等待重启")}</strong>
                <p>
                  {snapshot.error
                    ? localizedUpdaterErrorBody(snapshot.error)
                    : t("立即重启 Grapher 以切换到新版本。")}
                </p>
                {snapshot.error?.rawMessage && (
                  <p className="update-settings-error-detail">{snapshot.error.rawMessage}</p>
                )}
                <div className="update-settings-actions">
                  <button
                    type="button"
                    className="update-settings-primary-btn"
                    disabled={disabled}
                    onClick={() => void restartApp()}
                  >
                    <RotateCw size={13} aria-hidden="true" />
                    <span>{t("立即重启")}</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {snapshot.status === "restarting" && (
            <div className="update-settings-status-row" role="status">
              <Loader2 size={15} className="update-settings-spin" aria-hidden="true" />
              <div className="update-settings-status-body">
                <p>
                  {snapshot.platform === "windows"
                    ? t("已交由 Windows 安装程序更新并重启 Grapher…")
                    : t("正在重启 Grapher…")}
                </p>
              </div>
            </div>
          )}

          {snapshot.status === "error" && snapshot.error && (
            <div
              className={`update-settings-status-row ${
                snapshot.error.kind === "unsigned-unavailable" ? "is-warning" : "is-error"
              }`}
              role="alert"
            >
              {snapshot.error.kind === "unsigned-unavailable" ? (
                <Info size={15} aria-hidden="true" />
              ) : (
                <AlertTriangle size={15} aria-hidden="true" />
              )}
              <div className="update-settings-status-body">
                <strong>{localizedUpdaterErrorTitle(snapshot.error)}</strong>
                <p>{localizedUpdaterErrorBody(snapshot.error)}</p>
                {snapshot.error.kind !== "unsigned-unavailable" && (
                  <p className="update-settings-error-detail">{snapshot.error.rawMessage}</p>
                )}
                <div className="update-settings-actions">
                  <button
                    type="button"
                    className="update-settings-secondary-btn"
                    disabled={disabled || busy}
                    onClick={() => void retry()}
                  >
                    <RefreshCw size={13} aria-hidden="true" />
                    <span>{t("重试")}</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {update && snapshot.status !== "ready-to-restart" && snapshot.status !== "restarting" && (
            <div className="update-settings-panel" data-testid="updater-available-panel">
              <div className="update-settings-panel-header">
                <span className="update-settings-version-transition">
                  <span>{t("发现新版本")}</span>
                  {update.currentVersion && (
                    <>
                      <code>{formatVersion(update.currentVersion)}</code>
                      <span aria-hidden="true">→</span>
                    </>
                  )}
                  <code>{formatVersion(update.version)}</code>
                </span>
                {formattedDate && (
                  <span className="update-settings-date">{t("发布于 {0}", formattedDate)}</span>
                )}
              </div>

              <div className="update-settings-notes-wrap">
                <span className="update-settings-notes-label">{t("更新日志")}</span>
                <div className="update-settings-notes">
                  {update.body || t("此版本未附带更新说明，可在 GitHub Releases 中查看完整变更记录。")}
                </div>
              </div>

              {snapshot.downloadCancelled && snapshot.status === "available" && (
                <p className="section-desc" role="status">
                  {t("已取消下载。您可以随时重试安装。")}
                </p>
              )}

              {(snapshot.status === "downloading" || snapshot.status === "cancelling") && progress && (
                <div className="update-settings-progress-wrap">
                  <div className="update-settings-progress-meta">
                    <span>
                      {snapshot.status === "cancelling"
                        ? t("正在取消下载…")
                        : progress.percent !== null
                          ? t("正在下载更新… {0}%", progress.percent)
                          : t("正在下载更新…")}
                    </span>
                    <span className="update-settings-progress-bytes">
                      {progress.totalBytes
                        ? `${formatUpdaterBytes(progress.downloadedBytes)} / ${formatUpdaterBytes(progress.totalBytes)}`
                        : formatUpdaterBytes(progress.downloadedBytes)}
                    </span>
                  </div>
                  <div
                    className="update-settings-progress-track"
                    role="progressbar"
                    aria-label={t("更新下载进度")}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progress.percent ?? undefined}
                  >
                    <div
                      className={`update-settings-progress-fill${
                        progress.percent === null ? " is-indeterminate" : ""
                      }`}
                      style={progress.percent !== null ? { width: `${progress.percent}%` } : undefined}
                    />
                  </div>
                </div>
              )}

              {snapshot.status === "installing" && (
                <div className="update-settings-status-row" role="status">
                  <Loader2 size={15} className="update-settings-spin" aria-hidden="true" />
                  <div className="update-settings-status-body">
                    <p>
                      {snapshot.platform === "windows"
                        ? t("正在启动 Windows 安装程序，Grapher 将自动关闭并重启…")
                        : t("正在安装更新并准备重启，请勿关闭 Grapher…")}
                    </p>
                  </div>
                </div>
              )}

              <div className="update-settings-actions">
                {snapshot.status === "downloading" || snapshot.status === "cancelling" ? (
                  <button
                    type="button"
                    className="update-settings-secondary-btn"
                    disabled={disabled || !snapshot.canCancelDownload}
                    onClick={cancelDownload}
                  >
                    <X size={13} aria-hidden="true" />
                    <span>
                      {snapshot.status === "cancelling" ? t("正在取消…") : t("取消下载")}
                    </span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="update-settings-primary-btn"
                    disabled={disabled || busy}
                    onClick={() => void installAndRestart()}
                  >
                    <Download size={13} aria-hidden="true" />
                    <span>
                      {snapshot.downloadCancelled || snapshot.error
                        ? t("重试安装并重启")
                        : t("安装并重启")}
                    </span>
                  </button>
                )}
              </div>
            </div>
          )}

          {snapshot.status === "idle" && (
            <p className="section-desc">
              {t("点击「检查更新」以从 GitHub Releases 检查适用于当前平台的签名更新。")}
            </p>
          )}
        </>
      )}

      <p className="update-settings-footnote">
        {t(
          "应用内更新仅接受经过签名验证的发布包；未签名的 CI 或本地构建不包含可安装的签名更新包，但不会影响应用启动。",
        )}{" "}
        <a href={UPDATER_RELEASES_URL} target="_blank" rel="noopener noreferrer">
          GitHub Releases
        </a>
      </p>
    </section>
  );
};

UpdateSettings.displayName = "UpdateSettings";
