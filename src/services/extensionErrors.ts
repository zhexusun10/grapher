// Shared by live Planner output and paged/replayed execution transcripts.
export function extensionErrorText(event: { extensionPath?: unknown; event?: unknown; error?: unknown }): string {
  const path = typeof event.extensionPath === "string" ? event.extensionPath : "unknown extension";
  const hook = typeof event.event === "string" && event.event ? ` (${event.event})` : "";
  const error = typeof event.error === "string" && event.error ? event.error : "Unknown extension error";
  return `Extension error: ${path}${hook}\n${error}`;
}
