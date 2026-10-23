import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";

/** 唯一的速度表，单位 ms/字。队列越积压越快，空闲时逐字慢打。 */
const SPEED = { SLOW: 15, NORMAL: 10, FAST: 3, WARP: 0 } as const;
/** 流式积压时每帧最多取出的字符数（最高档，放慢以免看起来像整段蹦出）。 */
const MAX_STREAM_PER_FRAME = 6;
/** 后端结束后每帧最多清空的积压字符数（收尾档，比流式略快但仍逐段打出）。 */
const DRAIN_PER_FRAME = 20;

// 客户端用 layout effect 在首帧绘制前把已存在的流式内容重置为空；服务端渲染
// （测试里的 renderToStaticMarkup）不执行 effect，因此首帧仍包含完整文本。
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * 打字机式逐字揭示流式模型输出：生产者-消费者模型。
 *
 * 生产者：`targetText` 增长时，把新增字符按码点拆开压入队列。
 * 消费者：requestAnimationFrame 循环，按队列积压量弹性调速取字。
 *
 * 关键点：
 * - 内容进入时从空开始逐字打出，而不是整段蹦出；
 * - 队列积压时自动加速（流式最高 6 字/帧），空闲时放慢（15ms/字）；
 * - 后端结束后继续以 20 字/帧清空剩余字符，绝不在结束时直接跳到完整文本，
 *   因此不会出现收尾时的整屏闪烁；
 * - 折叠的思维链卡片暂停消费（进度冻结），展开后继续打字；
 * - “减少动态效果”时直接显示完整文本。
 */
export function useSmoothStreamText(targetText: string, isStreaming: boolean, enabled = true): string {
  const reduceMotion = useReducedMotion();
  const [displayedText, setDisplayedText] = useState(targetText);

  const displayedRef = useRef(targetText);
  const queueRef = useRef<string[]>([]);
  const queueIndexRef = useRef(0);
  const enqueuedRef = useRef(isStreaming ? "" : targetText);
  const targetRef = useRef(targetText);
  const streamingRef = useRef(isStreaming);
  const enabledRef = useRef(enabled);
  const reduceMotionRef = useRef(Boolean(reduceMotion));
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef(0);
  const initializedRef = useRef(false);

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

    const queue = queueRef.current;
    let pending = queue.length - queueIndexRef.current;
    const backendDone = !streamingRef.current;
    let charsToPop = 0;
    let interval: number = SPEED.NORMAL;
    if (backendDone && pending > 0) {
      charsToPop = Math.min(pending, DRAIN_PER_FRAME);
      interval = SPEED.WARP;
    } else if (pending > 100) {
      charsToPop = MAX_STREAM_PER_FRAME;
      interval = SPEED.WARP;
    } else if (pending > 50) {
      charsToPop = 5;
      interval = SPEED.FAST;
    } else if (pending > 20) {
      charsToPop = 2;
      interval = SPEED.NORMAL;
    } else if (pending < 5) {
      charsToPop = 1;
      interval = SPEED.SLOW;
    } else {
      charsToPop = 1;
      interval = SPEED.NORMAL;
    }

    const elapsed = now - lastTickRef.current;
    if (charsToPop > 0 && (interval === SPEED.WARP || elapsed >= interval)) {
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

    // 后端完成且队列清空才算真正结束；否则继续排帧等待/消费。
    if (backendDone && pending === 0) return;
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const ensureLoop = useCallback(() => {
    if (rafRef.current !== null) return;
    if (!enabledRef.current || reduceMotionRef.current) return;
    lastTickRef.current = performance.now();
    rafRef.current = requestAnimationFrame(tick);
  }, [tick]);

  // 生产者：目标文本增长时把增量字符入队。
  useEffect(() => {
    const target = targetText;
    if (reduceMotionRef.current) {
      queueRef.current = [];
      queueIndexRef.current = 0;
      enqueuedRef.current = target;
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
      setDisplayedText(target);
      return;
    }
    if (target.length > enqueuedRef.current.length) {
      // for...of 按码点迭代，避免大块内容用展开运算符 push 时超出调用栈上限。
      for (const char of target.slice(enqueuedRef.current.length)) queueRef.current.push(char);
      enqueuedRef.current = target;
      ensureLoop();
    }
  }, [targetText, ensureLoop]);

  // 挂载时如果已经是流式中（组件可能带着首批内容挂载），从空开始逐字打出。
  // StrictMode 会 setup→cleanup→setup，用 ref 保证只初始化一次，避免重复入队。
  useIsomorphicLayoutEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    if (!streamingRef.current || reduceMotionRef.current) return;
    queueRef.current = [];
    queueIndexRef.current = 0;
    enqueuedRef.current = "";
    displayedRef.current = "";
    setDisplayedText("");
    if (targetRef.current) {
      for (const char of targetRef.current) queueRef.current.push(char);
      enqueuedRef.current = targetRef.current;
      ensureLoop();
    }
  }, [ensureLoop]);

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

  useEffect(() => stopLoop, [stopLoop]);

  return reduceMotion ? targetText : displayedText;
}

export default useSmoothStreamText;
