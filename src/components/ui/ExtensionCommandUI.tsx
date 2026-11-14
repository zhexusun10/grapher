import { useEffect, useRef, useState } from "react";
import "./composer-commands.css";
import { t } from "../../i18n";
import type { ExtensionUIRequest } from "../../services/composerCommands";

export function ExtensionCommandUI({ request, respond }: {
  request: ExtensionUIRequest;
  respond: (id: string, response: Record<string, unknown>) => Promise<void>;
}) {
  const [value, setValue] = useState(request.prefill ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  const send = async (response: Record<string, unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try { await respond(request.id, response); }
    catch (error) { setError(String(error)); setBusy(false); busyRef.current = false; }
  };
  useEffect(() => {
    if (!request.timeout) return;
    const timer = setTimeout(() => { void send({ cancelled: true }); }, request.timeout);
    return () => clearTimeout(timer);
  }, [request.id]);
  return <section className="prompt-command-ui" role="group" aria-label={request.title || "Pi extension"}>
    <strong>{request.title}</strong>
    {request.message && <p>{request.message}</p>}
    {request.method === "select" ? <div className="prompt-command-options">
      {request.options?.map((option, index) => <button type="button" key={index} disabled={busy}
        onClick={() => void send({ value: option })}>{option}</button>)}
    </div> : request.method === "confirm" ? <>
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
