import { isTauriDesktop } from "./apiBase";

export type GitBootstrapPhase = "not_needed" | "downloading" | "ready" | "failed";

export interface GitBootstrapStatus {
  phase: GitBootstrapPhase;
  gitPath: string | null;
  error: string | null;
}

type TauriInvoke = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

interface TauriRuntimeGlobal {
  __TAURI_INTERNALS__?: {
    invoke?: TauriInvoke;
  };
  __TAURI__?: {
    core?: {
      invoke?: TauriInvoke;
    };
  };
}

function getTauriInvoke(): TauriInvoke | null {
  if (!isTauriDesktop() || typeof globalThis === "undefined") return null;
  const tauri = globalThis as unknown as TauriRuntimeGlobal;
  if (typeof tauri.__TAURI_INTERNALS__?.invoke === "function") {
    return tauri.__TAURI_INTERNALS__.invoke;
  }
  if (typeof tauri.__TAURI__?.core?.invoke === "function") {
    return tauri.__TAURI__.core.invoke;
  }
  return null;
}

function normalizeStatus(raw: unknown): GitBootstrapStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Record<string, unknown>;
  const phase = candidate.phase;
  if (
    phase !== "not_needed" &&
    phase !== "downloading" &&
    phase !== "ready" &&
    phase !== "failed"
  ) {
    return null;
  }
  return {
    phase,
    gitPath: typeof candidate.gitPath === "string" ? candidate.gitPath : null,
    error: typeof candidate.error === "string" ? candidate.error : null,
  };
}

export async function getGitBootstrapStatus(): Promise<GitBootstrapStatus | null> {
  const invoke = getTauriInvoke();
  if (!invoke) return null;
  try {
    return normalizeStatus(await invoke("git_bootstrap_status"));
  } catch {
    return null;
  }
}

export async function retryGitBootstrap(): Promise<GitBootstrapStatus | null> {
  const invoke = getTauriInvoke();
  if (!invoke) return null;
  try {
    return normalizeStatus(await invoke("retry_git_bootstrap"));
  } catch {
    return null;
  }
}
