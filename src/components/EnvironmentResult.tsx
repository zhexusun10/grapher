import { useLayoutEffect, useRef, useState } from "react";
import type { Snapshot } from "../types";
import { runtimeService } from "../services/runtime";
import { t, localizeError } from "../i18n";

export function EnvironmentResult({ state }: { state: Snapshot }) {
  const [args, setArgs] = useState("[]");
  const [output, setOutput] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [entryId, setEntryId] = useState("");
  const currentView = useRef({ runId: state.runId });
  useLayoutEffect(() => {
    currentView.current = { runId: state.runId }; setArgs("[]"); setOutput(""); setError(""); setBusy(false); setEntryId("");
  }, [state.runId]);
  if (!state.publishedResult) return null;
  const running = state.resultExecution?.status === "running";
  const retry = state.resultExecution?.status === "failed" && state.phase === "needs_attention";
  const entries = state.publishedResult.entries ?? [];
  const failedEntry = retry ? entries.find(entry => entry.workspace === state.resultExecution?.input.layout)?.name : undefined;
  const selectedId = failedEntry ?? (entries.some(entry => entry.name === entryId) ? entryId : state.publishedResult.defaultEntry ?? "");
  const selectedEntry = entries.find(entry => entry.name === selectedId);
  const result = selectedEntry?.result ?? (entries.length ? undefined : state.publishedResult.result);
  const workspace = selectedEntry?.workspace ?? (entries.length ? undefined : state.publishedResult.workspace);
  return <details>
    <summary>{t("可启动结果描述")}</summary>
    {entries.length > 0 && <label>{t("业务入口")}
      <select aria-label={t("业务入口")} value={selectedId} disabled={busy || running || retry} onChange={event => setEntryId(event.target.value)}>
        <option value="" disabled>{t("请选择业务入口")}</option>
        {entries.map(entry => <option key={entry.name} value={entry.name}>{entry.name}</option>)}
      </select>
    </label>}
    {workspace && <p><code>{workspace}</code></p>}
    {result && <p><code>E: {result.environmentRef} · L: {result.launchRef}</code></p>}
    <p className="section-desc">{t("通过 Runtime 启动业务入口，不调用模型。修改会记录新结果并重新发布；失败保留部分工作。不会激活源项目的环境。")}</p>
    <button type="button" className="text-button" onClick={() => void navigator.clipboard.writeText(JSON.stringify(state.publishedResult, null, 2)).catch(() => {})}>{t("复制结果描述")}</button>
    <label>{t("入口参数 JSON（字符串数组）")}
      <input aria-label={t("入口参数 JSON（字符串数组）")} value={args} disabled={busy || running} onChange={event => setArgs(event.target.value)} />
    </label>
    <button type="button" className="text-button" disabled={busy || running || (entries.length > 0 && !selectedEntry) || !(state.phase === "completed" || retry)} onClick={async () => {
      const view = currentView.current;
      try {
        const values: unknown = JSON.parse(args);
        if (!Array.isArray(values) || !values.every(value => typeof value === "string")) throw new Error(t("入口参数必须是字符串数组。"));
        setError(""); setOutput(""); setBusy(true);
        const result = await runtimeService.launchResult(view.runId, values, selectedEntry?.name);
        if (currentView.current === view) setOutput(result.output);
      } catch (error) { if (currentView.current === view) setError(localizeError(error)); }
      finally { if (currentView.current === view) setBusy(false); }
    }}>{retry ? t("保留部分工作重试结果") : t("启动结果（无模型）")}</button>
    {(busy || running) && <button type="button" className="text-button" onClick={() => {
      const view = currentView.current;
      void runtimeService.cancelResult(view.runId).catch(error => {
        if (currentView.current === view) setError(localizeError(error));
      });
    }}>{t("取消结果进程")}</button>}
    {error && <p role="alert">{error}</p>}
    {output && <pre style={{ maxHeight: 240, overflow: "auto" }}>{output}</pre>}
  </details>;
}
