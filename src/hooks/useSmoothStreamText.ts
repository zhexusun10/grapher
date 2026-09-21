/**
 * 返回最新的流式文本。
 *
 * SSE 本身已经是增量的；旧实现又用每帧追加 1 个字符的打字机动画，
 * 输出稍快就会严重滞后，并让 Markdown 和布局重复计算。这里不再人为
 * 节流，直接显示最新增量。
 */
export function useSmoothStreamText(targetText: string, _isStreaming: boolean): string {
  return targetText;
}

export default useSmoothStreamText;

