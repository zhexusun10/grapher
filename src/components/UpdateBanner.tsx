import React from "react";
import { ArrowUpCircle, Download, Loader2, RotateCw, X } from "lucide-react";
import { t } from "../i18n";
import { formatUpdaterBytes, type UpdaterSnapshot } from "../services/updater";

function formatVersion(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

export interface UpdateBannerProps {
  snapshot: UpdaterSnapshot;
  hidden?: boolean;
  onOpenSettings: () => void;
  onInstallAndRestart: () => void;
  onCancelDownload: () => void;
  onRestart: () => void;
  onDismiss: () => void;
}

export const UpdateBanner: React.FC<UpdateBannerProps> = React.memo(({
  snapshot,
  hidden = false,
  onOpenSettings,
  onInstallAndRestart,
  onCancelDownload,
  onRestart,
  onDismiss,
}) => {
  if (!snapshot.supported || hidden) return null;

  const update = snapshot.availableUpdate;
  const visibleStatus =
    snapshot.status === "available" ||
    snapshot.status === "downloading" ||
    snapshot.status === "cancelling" ||
    snapshot.status === "installing" ||
    snapshot.status === "ready-to-restart" ||
    snapshot.status === "restarting";

  if (!visibleStatus) return null;
  if (
    snapshot.status === "available" &&
    update &&
    snapshot.dismissedBannerVersion === update.version
  ) {
    return null;
  }

  const versionLabel = update ? formatVersion(update.version) : "";
  const progress = snapshot.progress;

  let title = versionLabel
    ? t("发现新版本 Grapher {0}", versionLabel)
    : t("发现新版本");
  let subtitle: string | null = update?.currentVersion
    ? `${formatVersion(update.currentVersion)} → ${versionLabel}`
    : null;

  if (snapshot.status === "downloading" && progress) {
    title =
      progress.percent !== null
        ? t("正在下载更新… {0}%", progress.percent)
        : t("正在下载更新…");
    subtitle = progress.totalBytes
      ? `${formatUpdaterBytes(progress.downloadedBytes)} / ${formatUpdaterBytes(progress.totalBytes)}`
      : formatUpdaterBytes(progress.downloadedBytes);
  } else if (snapshot.status === "cancelling") {
    title = t("正在取消下载…");
    subtitle = null;
  } else if (snapshot.status === "installing") {
    title =
      snapshot.platform === "windows"
        ? t("正在启动 Windows 安装程序…")
        : t("正在安装更新…");
    subtitle =
      snapshot.platform === "windows"
        ? t("Grapher 将自动关闭并重启")
        : t("请勿关闭 Grapher");
  } else if (snapshot.status === "ready-to-restart") {
    title = t("更新已安装，重启即可生效");
    subtitle = null;
  } else if (snapshot.status === "restarting") {
    title =
      snapshot.platform === "windows"
        ? t("正在交由安装程序重启 Grapher…")
        : t("正在重启 Grapher…");
    subtitle = null;
  }

  const inProgress =
    snapshot.status === "downloading" ||
    snapshot.status === "cancelling" ||
    snapshot.status === "installing" ||
    snapshot.status === "restarting";

  return (
    <div className="floating-update-banner" role="status" aria-live="polite">
      <div className="floating-update-icon" aria-hidden="true">
        {inProgress ? (
          <Loader2 size={14} className="update-settings-spin" />
        ) : (
          <ArrowUpCircle size={14} />
        )}
      </div>
      <div className="floating-update-copy">
        <span className="floating-update-title">{title}</span>
        {subtitle && <span className="floating-update-sub">{subtitle}</span>}
      </div>
      <div className="floating-update-actions">
        <button
          type="button"
          className="floating-update-btn"
          onClick={onOpenSettings}
        >
          {t("查看详情")}
        </button>
        {snapshot.status === "available" && (
          <button
            type="button"
            className="floating-update-btn is-primary"
            onClick={onInstallAndRestart}
          >
            <Download size={12} />
            <span>{t("安装并重启")}</span>
          </button>
        )}
        {(snapshot.status === "downloading" || snapshot.status === "cancelling") && (
          <button
            type="button"
            className="floating-update-btn"
            disabled={!snapshot.canCancelDownload}
            onClick={onCancelDownload}
          >
            <span>{snapshot.status === "cancelling" ? t("正在取消…") : t("取消下载")}</span>
          </button>
        )}
        {snapshot.status === "ready-to-restart" && (
          <button
            type="button"
            className="floating-update-btn is-primary"
            onClick={onRestart}
          >
            <RotateCw size={12} />
            <span>{t("立即重启")}</span>
          </button>
        )}
        {snapshot.status === "available" && (
          <button
            type="button"
            className="floating-update-close"
            aria-label={t("稍后提醒")}
            onClick={onDismiss}
          >
            <X size={13} />
          </button>
        )}
      </div>
    </div>
  );
});

UpdateBanner.displayName = "UpdateBanner";
