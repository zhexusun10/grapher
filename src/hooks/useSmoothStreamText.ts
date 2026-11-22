import { useCallback, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";

/** 最小提交间隔（~30fps）：在保持字符速率不变的同时，避免 60–120Hz 逐帧重跑 Markdown + sanitize-html。 */
const FRAME_INTERVAL_MS = 32;
/** 流式积压时每次提交最多取出的字符数（按 32ms 折合 ~375 字/秒，与 60fps × 6 字/帧速率一致）。 */
const MAX_STREAM_PER_TICK = 12;
/** 后端结束后每次提交最多清空的积压字符数（按 32ms 折合 ~1250 字/秒，与 60fps × 20 字/帧速率一致）。 */
const DRAIN_PER_TICK = 40;

/**
 * 打字机式逐字揭示流式模型输出：生产者-消费者模型。
 *
 * 生产者：`targetText` 增长时，把新增字符按码点拆开压入队列。
 * 消费者：requestAnimationFrame 循环，按队列积压量弹性调速取字；
 * 队列为空或页面隐藏时立即停帧，杜绝空转 CPU 消耗。
 */
export function useSmoothStreamText(targetText: string, isStreaming: boolean, enabled = true): string {
  const reduceMotion = useReducedMotion();
  const [displayedText, setDisplayedText] = useState(targetText);

  const displayedRef = useRef(targetText);
  const queueRef = useRef<string[]>([]);
  const queueIndexRef = useRef(0);
  const enqueuedRef = useRef(targetText);
  const targetRef = useRef(targetText);
  const streamingRef = useRef(isStreaming);
  const enabledRef = useRef(enabled);
  const reduceMotionRef = useRef(Boolean(reduceMotion));
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef(0);

  targetRef.current = targetText;
  streamingRef.current = isStreaming;
  enabledRef.current = enabled;
  reduceMotionRef.current = Boolean(reduceMotion);

  const stopLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const tick = useCallback((now: number) => {
    rafRef.current = null;
    if (!enabledRef.current || reduceMotionRef.current) return;
    if (typeof document !== "undefined" && document.hidden) return;

    const queue = queueRef.current;
    let pending = queue.length - queueIndexRef.current;
    // 队列为空时立即停止 rAF，等生产者入队新字符时再唤醒，避免 60–120fps 空转。
    if (pending <= 0) return;

    const backendDone = !streamingRef.current;
    let charsToPop = 0;
    if (backendDone) {
      charsToPop = Math.min(pending, DRAIN_PER_TICK);
    } else if (pending > 100) {
      charsToPop = MAX_STREAM_PER_TICK;
    } else if (pending > 50) {
      charsToPop = 10;
    } else if (pending > 20) {
      charsToPop = 6;
    } else if (pending >= 5) {
      charsToPop = 3;
    } else {
      charsToPop = 2;
    }

    const elapsed = now - lastTickRef.current;
    if (charsToPop > 0 && elapsed >= FRAME_INTERVAL_MS) {
      lastTickRef.current = now;
      const start = queueIndexRef.current;
      const end = Math.min(queue.length, start + charsToPop);
      displayedRef.current += queue.slice(start, end).join("");
      queueIndexRef.current = end;
      pending = queue.length - end;
      setDisplayedText(displayedRef.current);
      if (end === queue.length) {
        queueRef.current = [];
        queueIndexRef.current = 0;
      }
    }

    if (pending > 0) {
      rafRef.current = requestAnimationFrame(tick);
    }
  }, []);

  const ensureLoop = useCallback(() => {
    if (rafRef.current !== null) return;
    if (!enabledRef.current || reduceMotionRef.current) return;
    if (typeof document !== "undefined" && document.hidden) return;
    if (queueRef.current.length <= queueIndexRef.current) return;
    // 首次启动时允许下一帧立即输出，且不依赖 performance.now 与 rAF 时钟完全同源。
    lastTickRef.current = -Infinity;
    rafRef.current = requestAnimationFrame(tick);
  }, [tick]);

  // 生产者：目标文本增长时把增量字符入队。
  useEffect(() => {
    const target = targetText;
    if (reduceMotionRef.current) {
      queueRef.current = [];
      queueIndexRef.current = 0;
      enqueuedRef.current = target;
      stopLoop();
      if (displayedRef.current !== target) {
        displayedRef.current = target;
        setDisplayedText(target);
      }
      return;
    }
    if (!target.startsWith(enqueuedRef.current)) {
      // 内容被替换而不是追加：直接显示完整文本，避免反复重打。
      queueRef.current = [];
      queueIndexRef.current = 0;
      enqueuedRef.current = target;
      displayedRef.current = target;
      stopLoop();
      setDisplayedText(target);
      return;
    }
    if (target.length > enqueuedRef.current.length) {
      // for...of 按码点迭代，避免大块内容用展开运算符 push 时超出调用栈上限。
      for (const char of target.slice(enqueuedRef.current.length)) queueRef.current.push(char);
      enqueuedRef.current = target;
      ensureLoop();
    }
  }, [targetText, ensureLoop, stopLoop]);

  // 后端结束时若仍有未消费积压，唤醒消费以收尾档清空。
  useEffect(() => {
    if (!isStreaming && queueRef.current.length > queueIndexRef.current) {
      ensureLoop();
    }
  }, [isStreaming, ensureLoop]);

  // 可见性 / 减少动态效果开关。
  useEffect(() => {
    if (reduceMotion) {
      queueRef.current = [];
      queueIndexRef.current = 0;
      enqueuedRef.current = targetRef.current;
      displayedRef.current = targetRef.current;
      setDisplayedText(targetRef.current);
      stopLoop();
      return;
    }
    if (enabled) ensureLoop();
    else stopLoop();
  }, [enabled, reduceMotion, ensureLoop, stopLoop]);

  // 页面隐藏时暂停打字循环，恢复可见时继续排空积压字符。
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => {
      if (document.hidden) stopLoop();
      else ensureLoop();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [ensureLoop, stopLoop]);

  useEffect(() => stopLoop, [stopLoop]);

  return reduceMotion ? targetText : displayedText;
}

export default useSmoothStreamText;
