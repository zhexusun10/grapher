import { t, localizeError } from "../i18n";
import { useEffect, useLayoutEffect, useRef, useState, memo, useMemo } from "react";
import { runtimeService } from "../services/runtime";
import { VirtualizedTranscript } from "./VirtualizedTranscript";

export const planningTranscriptCache = new Map<string, { text: string; offset: number; complete: boolean }>();

export async function prefetchPlanningTranscript(planningIds: string[], signal?: AbortSignal): Promise<string> {
  const key = planningIds.join(":");
  const cached = planningTranscriptCache.get(key);
  if (cached && cached.complete) return cached.text;
  let text = "";
  for (const planningId of planningIds) {
    text += `${JSON.stringify({ type: "grapher_planning_source", planningId })}\n`;
    let currentOffset = 0;
    while (!signal?.aborted) {
      const page = await runtimeService.getPlanningOutput(planningId, "planner", currentOffset, signal);
      if (signal?.aborted) return text;
      if (page.planningId !== planningId || page.role !== "planner" || page.nextOffset < currentOffset || (!page.complete && page.nextOffset === currentOffset)) {
        throw new Error(t("规划记录与请求不匹配，请重试。"));
      }
      text += page.content;
      currentOffset = page.nextOffset;
      if (page.complete) {
        if (!page.running && text && !text.endsWith("\n")) {
          text += "\n";
        }
        break;
      }
    }
  }
  planningTranscriptCache.set(key, { text, offset: text.length, complete: true });
  return text;
}

export function activePlannerOutput(output: string, edits: Array<{ old_instruction?: string; nextPlanningId?: string }>): string {
  let active = output;
  for (const edit of edits) {
    if (!edit.old_instruction) continue;
    const lines = active.split("\n");
    const start = lines.findIndex((line) => {
      try {
        const event = JSON.parse(line);
        if (event.type !== "message_start" && event.type !== "message_end") return false;
        if (event.message?.role !== "user") return false;
        const text = (event.message.content || []).filter((part: { type: string }) => part.type === "text")
          .map((part: { text: string }) => part.text).join("\n");
        return text === edit.old_instruction || text.endsWith(`\n${edit.old_instruction}`);
      } catch { return false; }
    });
    if (start < 0) continue;
    const resume = edit.nextPlanningId ? lines.findIndex((line, index) => index > start &&
      line.includes(`"type":"grapher_planning_source"`) && line.includes(`"planningId":"${edit.nextPlanningId}"`)) : -1;
    active = [...lines.slice(0, start), ...(resume >= 0 ? lines.slice(resume) : [])].join("\n");
  }
  return active;
}

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
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    const wait = () => new Promise<void>((resolve) => {
      wake = resolve;
      timer = setTimeout(() => { wake = undefined; resolve(); }, 1000);
    });
    const poll = async () => {
      try {
        let text = "";
        for (const planningId of planningIds) {
          let offset = 0;
          if (text && !text.endsWith("\n")) text += "\n";
          text += `${JSON.stringify({ type: "grapher_planning_source", planningId })}\n`;
          while (!abort.signal.aborted) {
            const page = await runtimeService.getPlanningOutput(planningId, "planner", offset, abort.signal);
            if (abort.signal.aborted) return;
            if (page.planningId !== planningId || page.role !== "planner" || page.nextOffset < offset || (!page.complete && page.nextOffset === offset)) {
              throw new Error(t("规划记录与请求不匹配，请重试。"));
            }
            text += page.content;
            if (page.content) {
              setRecord({ id: key, content: text });
              planningTranscriptCache.set(key, { text, offset, complete: false });
            }
            offset = page.nextOffset;
            if (page.complete) {
              if (!page.running) {
                // A stopped process may leave its last JSONL record without a
                // newline; the transcript parser waits for a complete line.
                if (text && !text.endsWith("\n")) {
                  text += "\n";
                  setRecord({ id: key, content: text });
                }
                break;
              }
              await wait();
            }
          }
        }
        planningTranscriptCache.set(key, { text, offset: text.length, complete: true });
      } catch (error) {
        if (!abort.signal.aborted) setError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!abort.signal.aborted) {
          setLoading(false);
          onReadyRef.current?.();
        }
      }
    };
    void poll();
    return () => { abort.abort(); clearTimeout(timer); wake?.(); };
  }, [key, retry]);

  return <section className="planning-activity" aria-label={t("规划活动记录")}>
    {loading && !output && <p role="status">{t("正在加载规划活动…")}</p>}
    {error && <p role="alert">{localizeError(error)} <button type="button" onClick={() => setRetry(value => value + 1)}>{t("重试")}</button></p>}
    {!loading && !error && !output && <p>{t("没有可用的规划输出。")}</p>}
    {output && <div className="planning-activity-output">
      <VirtualizedTranscript key={`${key}:${showUserTurns}:${skipFirstUser}:${editKey}`} output={activeOutput} inline
        showUserTurns={showUserTurns} skipFirstUser={skipFirstUser} onUserResize={onUserResize}
        onEditUser={onEditUser} />
    </div>}
  </section>;
});
