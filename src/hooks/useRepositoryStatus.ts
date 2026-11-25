import { t } from "../i18n";
import { useEffect, useState } from "react";
import { runtimeService } from "../services/runtime";
import { shareJson } from "../services/structuralSharing";
import { startVisibilityPolling } from "../services/visibilityPolling";

const REPOSITORY_STATUS_POLL_MS = 5000;

// This checks only the selected binding. Viewing another project must never
// change the repository stored in a running backend execution.
export function useRepositoryStatus(repository: string) {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof runtimeService.repositoryStatus>>>();
  useEffect(() => {
    if (!repository) return;
    const controller = new AbortController();
    const check = async (): Promise<number | null> => {
      if (controller.signal.aborted) return null;
      try {
        const result = await runtimeService.repositoryStatus(repository, controller.signal);
        if (!controller.signal.aborted) setStatus(previous => shareJson(previous, result));
      } catch (error) {
        if (!controller.signal.aborted) {
          setStatus(previous => shareJson(previous, { repository, valid: false, error: t("无法确认项目绑定：{0}", String(error)) }));
        }
      }
      return controller.signal.aborted ? null : REPOSITORY_STATUS_POLL_MS;
    };
    const polling = startVisibilityPolling(check, 0);
    const onFocus = () => polling.wake();
    window.addEventListener("focus", onFocus);
    return () => {
      controller.abort();
      polling();
      window.removeEventListener("focus", onFocus);
    };
  }, [repository]);
  // A result for the previous selection cannot validate a new project.
  return status?.repository === repository ? status : undefined;
}
