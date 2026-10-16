/**
 * Formats a duration for tool cards the way terminals report command time:
 * sub-ten-second values keep one decimal (`0.3s`), then minutes and hours.
 */
export function formatToolDuration(durationMs: number): string {
  const totalMs = Math.max(0, Math.round(durationMs));
  if (totalMs < 10_000) return `${(totalMs / 1000).toFixed(1)}s`;
  const totalSeconds = Math.floor(totalMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ${seconds}s`;
}
