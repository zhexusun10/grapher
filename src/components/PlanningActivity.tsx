import { t, localizeError } from "../i18n";
import { useEffect, useLayoutEffect, useRef, useState, memo, useMemo } from "react";
import { runtimeService } from "../services/runtime";
import { startVisibilityPolling } from "../services/visibilityPolling";
import { useStableCallback } from "../hooks/useStableCallback";
import { VirtualizedTranscript } from "./VirtualizedTranscript";

import { utf8Bytes } from "../lib/BoundedLruCache";
import { planningTranscriptCache } from "../services/transcriptCache";
import { activePlannerOutput } from "../lib/plannerOutput";
export { planningTranscriptCache } from "../services/transcriptCache";
export { activePlannerOutput } from "../lib/plannerOutput";

export const PlanningActivity = memo(function PlanningActivity({ planningIds, onReady, showUserTurns = false, skipFirstUser = false, onUserResize, onEditUser, edits = [] }: {
  planningIds: string[];
  onReady?: () => void;
  showUserTurns?: boolean;
  skipFirstUser?: boolean;
  onUserResize?: (expanded?: boolean, card?: HTMLElement) => void;
  onEditUser?: (text: string, replacement: string) => boolean | void | Promise<unknown>;
  edits?: Array<{ old_instruction?: string; nextPlanningId?: string }>;
}) {
  const key = planningIds.join(":");
  const cached = planningTranscriptCache.get(key);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const [record, setRecord] = useState(() => ({
    id: key,
    content: cached ? cached.text : "",
  }));
  const output = record.id === key ? record.content : "";
  const editKey = JSON.stringify(edits);
  const activeOutput = useMemo(() => activePlannerOutput(output, edits), [output, editKey]);
  const [loading, setLoading] = useState(() => !cached);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useLayoutEffect(() => {
    if (cached?.complete) {
      onReadyRef.current?.();
    }
  }, [cached?.complete]);

  useEffect(() => {
    const cachedEntry = planningTranscriptCache.get(key);
    if (cachedEntry?.complete) {
      setRecord({ id: key, content: cachedEntry.text });
      setLoading(false);
      onReadyRef.current?.();
      return;
    }

    const abort = new AbortController();
    if (!cachedEntry) {
      setRecord({ id: key, content: "" });
      setLoading(true);
    }
    setError("");
    let stopWaiting = () => {};
    let wake: (() => void) | undefined;
    const wait = () => new Promise<void>((resolve) => {
      wake = resolve;
      stopWaiting = startVisibilityPolling(async () => { wake = undefined; resolve(); return null; }, 1000);
    });
    const poll = async () => {
      let notifiedReady = false;
      try {
        let text = "";
        let bytes = 0;
        for (const planningId of planningIds) {
          let offset = 0;
          if (text && !text.endsWith("\n")) { text += "\n"; bytes++; }
          const source = `${JSON.stringify({ type: "grapher_planning_source", planningId })}\n`;
          text += source;
          bytes += utf8Bytes(source);
          while (!abort.signal.aborted) {
            const page = await runtimeService.getPlanningOutput(planningId, "planner", offset, abort.signal);
            if (abort.signal.aborted) return;
            if (page.planningId !== planningId || page.role !== "planner" || page.nextOffset < offset || (!page.complete && page.nextOffset === offset)) {
              throw new Error(t("规划记录与请求不匹配，请重试。"));
            }
            text += page.content;
            bytes += page.nextOffset - offset;
            if (page.content) {
              setRecord({ id: key, content: text });
              planningTranscriptCache.set(key, { text, offset: bytes, complete: false });
            }
            offset = page.nextOffset;
            if (page.complete) {
              if (!notifiedReady && (offset > 0 || !page.running)) {
                notifiedReady = true;
                setLoading(false);
                onReadyRef.current?.();
              }
              if (!page.running) {
                // A stopped process may leave its last JSONL record without a
                // newline; the transcript parser waits for a complete line.
                if (text && !text.endsWith("\n")) {
                  text += "\n";
                  bytes++;
                  setRecord({ id: key, content: text });
                }
                break;
              }
              await wait();
            }
          }
        }
        planningTranscriptCache.set(key, { text, offset: bytes, complete: true });
      } catch (error) {
        if (!abort.signal.aborted) setError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!abort.signal.aborted) {
          setLoading(false);
          if (!notifiedReady) {
            notifiedReady = true;
            onReadyRef.current?.();
          }
        }
      }
    };
    void poll();
    return () => { abort.abort(); stopWaiting(); wake?.(); };
  }, [key, retry]);

  const editUser = useStableCallback((text: string, replacement: string) => onEditUser?.(text, replacement));
  return <section className="planning-activity" aria-label={t("规划活动记录")}>
    {loading && !output && <p role="status">{t("正在加载规划活动…")}</p>}
    {error && <p role="alert">{localizeError(error)} <button type="button" onClick={() => setRetry(value => value + 1)}>{t("重试")}</button></p>}
    {!loading && !error && !output && <p>{t("没有可用的规划输出。")}</p>}
    {output && <div className="planning-activity-output">
      <VirtualizedTranscript key={`${key}:${showUserTurns}:${skipFirstUser}:${editKey}`} output={activeOutput} inline
        showUserTurns={showUserTurns} skipFirstUser={skipFirstUser} onUserResize={onUserResize}
        onEditUser={onEditUser ? editUser : undefined} />
    </div>}
  </section>;
});
