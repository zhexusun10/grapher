import { useEffect, useState } from "react";
import { runtimeService } from "../services/runtime";

// This checks only the selected binding. Viewing another project must never
// change the repository stored in a running backend execution.
export function useRepositoryStatus(repository: string) {
  const [status, setStatus] = useState<{ repository: string; valid: boolean; error: string | null }>();
  useEffect(() => {
    if (!repository) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let checking = false;
    const check = async () => {
      if (checking || controller.signal.aborted) return;
      checking = true;
      clearTimeout(timer);
      try {
        const result = await runtimeService.repositoryStatus(repository, controller.signal);
        if (!controller.signal.aborted) setStatus(result);
      } catch (error) {
        if (!controller.signal.aborted) {
          setStatus({ repository, valid: false, error: `无法确认项目绑定：${String(error)}` });
        }
      } finally {
        checking = false;
        if (!controller.signal.aborted) timer = setTimeout(check, 5000);
      }
    };
    void check();
    window.addEventListener("focus", check);
    return () => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener("focus", check);
    };
  }, [repository]);
  // A result for the previous selection cannot validate a new project.
  return status?.repository === repository ? status : undefined;
}
