import { useState, useEffect, useRef } from "react";

/**
 * 平滑流式文本 Hook：
 * 提供基于 requestAnimationFrame 的打字机逐帧插值，
 * 防止大块 SSE/WebSocket 文本到达时造成突兀跳变，同时在滞后较大时自适应追赶。
 */
export function useSmoothStreamText(targetText: string, isStreaming: boolean): string {
  const [displayedText, setDisplayedText] = useState(targetText);
  const targetRef = useRef(targetText);
  targetRef.current = targetText;

  useEffect(() => {
    if (!isStreaming) {
      setDisplayedText(targetText);
      return;
    }

    let animationFrameId: number;
    let lastTime = performance.now();

    const tick = (now: number) => {
      const elapsed = now - lastTime;
      // 保持 ~16ms 逐帧节奏
      if (elapsed >= 16) {
        lastTime = now;
        setDisplayedText((prev) => {
          const target = targetRef.current;
          if (prev.length >= target.length) return target;

          const lag = target.length - prev.length;
          let step = 1;
          if (lag > 120) {
            step = Math.ceil(lag / 8);
          } else if (lag > 60) {
            step = 4;
          } else if (lag > 25) {
            step = 2;
          } else {
            step = 1;
          }

          return target.slice(0, prev.length + step);
        });
      }
      animationFrameId = requestAnimationFrame(tick);
    };

    animationFrameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationFrameId);
  }, [isStreaming]);

  useEffect(() => {
    if (targetText.length < displayedText.length) {
      setDisplayedText(targetText);
    }
  }, [targetText, displayedText.length]);

  return isStreaming ? displayedText : targetText;
}

export default useSmoothStreamText;
