import { useEffect, useId, useRef, useState } from "react";
import "./composer-commands.css";
import { t, localizeError } from "../../i18n";
import type { ExtensionUIRequest } from "../../services/composerCommands";

export function ExtensionCommandUI({ request, respond }: {
  request: ExtensionUIRequest;
  respond: (id: string, response: Record<string, unknown>) => Promise<void>;
}) {
  const [value, setValue] = useState(request.prefill ?? "");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  const panel = useRef<HTMLElement>(null);
  const titleId = useId();
  const searchable = request.method === 'select' && (request.options?.length ?? 0) > 8;
  const options = (request.options ?? []).filter(option => option.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  const send = async (response: Record<string, unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try { await respond(request.id, response); }
    catch (error) { setError(localizeError(String(error))); setBusy(false); busyRef.current = false; }
  };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = panel.current;
    element?.querySelector<HTMLElement>('input, textarea, button')?.focus();
    return () => {
      if (previous?.isConnected && (document.activeElement === document.body || element?.contains(document.activeElement))) previous.focus();
    };
  }, [request.id]);
  useEffect(() => {
    if (!request.timeout) return;
    const timer = setTimeout(() => { void send({ cancelled: true }); }, request.timeout);
    return () => clearTimeout(timer);
  }, [request.id]);
  return <section ref={panel} className="prompt-command-ui" role="group" aria-labelledby={titleId} aria-busy={busy}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); void send({ cancelled: true }); return;
      }
      if (busyRef.current) return;
      if (request.method === 'select' && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        // Home/End retain normal text editing in the filter field.
        if (event.target instanceof HTMLInputElement && !event.key.startsWith('Arrow')) return;
        const choices = [...(panel.current?.querySelectorAll<HTMLButtonElement>('button[data-extension-option]') ?? [])];
        if (!choices.length) return;
        const current = choices.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
          : event.key === 'ArrowDown' ? (current + 1) % choices.length : (current <= 0 ? choices.length : current) - 1;
        event.preventDefault(); event.stopPropagation(); choices[next]?.focus();
      } else if (event.key === 'Enter' && event.target instanceof HTMLInputElement && options[0]) {
        event.preventDefault(); event.stopPropagation(); void send({ value: options[0] });
      } else if (event.key === 'Enter' && event.target instanceof HTMLTextAreaElement &&
          (request.method === 'editor' ? event.ctrlKey || event.metaKey : !event.shiftKey)) {
        event.preventDefault(); event.stopPropagation(); void send({ value });
      }
    }}>
    <strong id={titleId}>{request.title}</strong>
    {request.message && <p>{request.message}</p>}
    {request.method === "select" ? <>
      {searchable && <input type="search" aria-label={t('筛选选项')} placeholder={t('筛选选项')}
        value={filter} disabled={busy} onChange={event => setFilter(event.target.value)} />}
      <div className="prompt-command-options">
        {options.map((option, index) => <button type="button" data-extension-option key={index} disabled={busy}
          onClick={() => void send({ value: option })}>{option}</button>)}
      </div>
      {options.length === 0 && <p role="status">{t('没有匹配的选项')}</p>}
    </> : request.method === "confirm" ? <>
      <button type="button" disabled={busy} onClick={() => void send({ confirmed: true })}>{t("确认")}</button>
      <button type="button" disabled={busy} onClick={() => void send({ confirmed: false })}>{t("否")}</button>
    </> : <>
      <textarea aria-label={request.title || "Pi extension input"} placeholder={request.placeholder}
        value={value} disabled={busy} onChange={event => setValue(event.target.value)} />
      <button type="button" disabled={busy} onClick={() => void send({ value })}>{t("提交")}</button>
    </>}
    <button type="button" disabled={busy} onClick={() => void send({ cancelled: true })}>{t("取消")}</button>
    {error && <p role="alert">{error}</p>}
  </section>;
}
