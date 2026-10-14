export interface ResolveGraphPhaseOptions {
  isPlanning: boolean;
  approved: boolean;
  paused?: boolean;
  canResume?: boolean;
  publishing: boolean;
  publicationFailed: boolean;
  phase: string;
  active?: boolean;
  nodes?: Record<string, { status: string }>;
  executions?: Array<{ status: string }>;
  mergers?: Array<{ node?: string; status: string }>;
  resultExecution?: { status: string } | null;
}

export function resolveGraphPhase(options: ResolveGraphPhaseOptions): string {
  const {
    isPlanning,
    approved,
    paused = false,
    canResume = false,
    publishing,
    publicationFailed,
    phase,
    active = false,
    nodes = {},
    executions = [],
    mergers = [],
    resultExecution,
  } = options;

  if (isPlanning && !approved) {
    return "planning";
  }

  const canContinue = !publishing && !publicationFailed && (paused || canResume === true);
  if (canContinue) {
    return "paused";
  }

  const isAnyNodeOrMergerWorking =
    active ||
    Object.values(nodes).some((n) => n.status === "running" || n.status === "dirty") ||
    executions.some((e) => e.status === "running") ||
    mergers.some((m) => m.status === "running") ||
    resultExecution?.status === "running";

  if (isAnyNodeOrMergerWorking && phase === "needs_attention") {
    const isPublicationMergerRunning = mergers.some((m) => m.node === "merger" && m.status === "running");
    return isPublicationMergerRunning ? "merging" : "running";
  }

  return phase;
}
