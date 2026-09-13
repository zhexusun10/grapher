import { useEffect, useRef, useState } from "react";
import { providerAuth, type LoginState, type ProviderCatalog } from "../services/providerAuth";

function AuthLink({ url, label }: { url?: string; label?: string }) {
  if (!url) return null;
  try { if (!["https:", "http:"].includes(new URL(url).protocol)) return null; } catch { return null; }
  return <a href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{label || "打开认证页面"}</a>;
}

export function ProviderSettings({ model, onModel }: { model: string; onModel: (model: string) => void }) {
  const [catalog, setCatalog] = useState<ProviderCatalog>();
  const [provider, setProvider] = useState(model.includes("/") ? model.slice(0, model.indexOf("/")) : "");
  const [login, setLogin] = useState<LoginState>();
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const activeId = useRef<string | undefined>(undefined);
  const selected = catalog?.providers.find(p => p.id === provider);

  async function load(refresh = false) {
    setBusy(true);
    setError("");
    try { const result = await providerAuth.catalog(refresh); if (mounted.current) setCatalog(result); }
    catch (err) { if (mounted.current) setError(String(err)); }
    finally { if (mounted.current) setBusy(false); }
  }

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      if (activeId.current) void providerAuth.cancel(activeId.current).catch(() => {});
    };
  }, []);

  useEffect(() => { setAnswer(""); }, [login?.prompt?.id]);
  useEffect(() => {
    if (!login || login.status !== "pending") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await providerAuth.poll(login.id);
        if (stopped) return;
        setLogin(next);
        if (next.status !== "pending") { activeId.current = undefined; void load(); }
        else timer = setTimeout(poll, 700);
      } catch (err) {
        if (!stopped) { setError(String(err)); activeId.current = undefined; setLogin(undefined); }
      }
    };
    timer = setTimeout(poll, 300);
    return () => { stopped = true; clearTimeout(timer); };
  }, [login?.id, login?.status]);

  async function start(method: string) {
    setBusy(true); setError(""); setLogin(undefined);
    try {
      const next = await providerAuth.login(provider, method);
      if (!mounted.current) { await providerAuth.cancel(next.id); return; }
      activeId.current = next.id;
      setLogin(next);
    } catch (err) { if (mounted.current) setError(String(err)); }
    finally { if (mounted.current) setBusy(false); }
  }

  async function respond() {
    if (!login?.prompt) return;
    const value = answer;
    setAnswer(""); setBusy(true); setError("");
    try { const next = await providerAuth.respond(login.id, login.prompt.id, value); if (mounted.current) setLogin(next); }
    catch (err) { if (mounted.current) setError(String(err)); }
    finally { if (mounted.current) setBusy(false); }
  }

  async function logout() {
    setBusy(true); setError("");
    try { await providerAuth.logout(provider); await load(); }
    catch (err) { if (mounted.current) setError(String(err)); }
    finally { if (mounted.current) setBusy(false); }
  }

  const pending = login?.status === "pending";
  return <div className="provider-settings">
    <div className="form-grid">
      <label className="form-field"><span>Provider</span>
        <select value={provider} disabled={busy || pending} onChange={e => { setProvider(e.target.value); onModel(""); setLogin(undefined); }}>
          <option value="">默认配置 / 全部 providers</option>
          {catalog?.providers.map(p => <option key={p.id} value={p.id}>{p.name} ({p.id}){p.configured ? " ✓" : ""}</option>)}
        </select>
      </label>
      <label className="form-field"><span>模型（留空使用默认配置）</span>
        <input list="provider-models" value={model} onChange={e => onModel(e.target.value)} placeholder="provider/model" />
        <datalist id="provider-models">
          {catalog?.models.filter(m => !provider || m.provider === provider).map(m =>
            <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>{m.name} · {m.api}{m.available ? " · 可用" : ""}</option>)}
        </datalist>
      </label>
    </div>
    {model && <p className="section-desc">API: {catalog?.models.find(m => `${m.provider}/${m.id}` === model)?.api || "由模型/provider 配置解析"}</p>}
    <div className="provider-actions">
      <button type="button" className="secondary" disabled={busy || pending} onClick={() => void load()}>刷新状态</button>
      <button type="button" className="secondary" disabled={busy || pending} onClick={() => void load(true)}>同步模型目录（联网）</button>
    </div>
    {selected && <div className="provider-auth-panel">
      <p>{selected.name}：{selected.configured ? `已配置 (${selected.authType})` : "未配置认证"}</p>
      <div className="provider-actions">
        {selected.methods.map(method => <button type="button" className="secondary" key={method.id} disabled={busy || pending} onClick={() => void start(method.id)}>{method.name}</button>)}
        <button type="button" className="secondary" disabled={busy || pending} onClick={() => void logout()}>退出 / 移除保存的凭据</button>
      </div>
      {!selected.methods.length && <p className="section-desc">此 provider 使用环境变量、本机 profile 或其他环境认证方式。</p>}
    </div>}
    <p className="section-desc">凭据由内核原生认证设施管理，不保存在 Grapher 图、事件或浏览器存储中。退出不会清除环境变量或本机 profile。自定义 API、endpoint 和 provider 配置继承本机 models.json。</p>
    {login && <div className="provider-auth-panel" aria-live="polite">
      <strong>认证状态：{login.status}</strong>
      {login.events.map((event, i) => <div key={i}>
        {event.message && <p>{event.message}</p>}
        {event.instructions && <p>{event.instructions}</p>}
        {event.userCode && <p>设备码：<code>{event.userCode}</code></p>}
        <AuthLink url={event.url || event.verificationUri} />
        {event.links?.map((link, index) => <AuthLink key={index} url={link.url} label={link.label} />)}
      </div>)}
      {login.prompt && <div className="form-field">
        <label htmlFor="auth-answer">{login.prompt.message}</label>
        {login.prompt.type === "select" ? <select id="auth-answer" value={answer} onChange={e => setAnswer(e.target.value)}>
          <option value="">请选择</option>
          {login.prompt.options?.map(o => <option key={o.id} value={o.id}>{o.label}{o.description ? ` — ${o.description}` : ""}</option>)}
        </select> : <input id="auth-answer" type={login.prompt.type === "secret" || login.prompt.type === "manual_code" ? "password" : "text"} autoComplete="off" spellCheck={false} value={answer} placeholder={login.prompt.placeholder} onChange={e => setAnswer(e.target.value)} />}
        <button type="button" className="secondary" disabled={busy} onClick={() => void respond()}>提交</button>
      </div>}
      {pending && <button type="button" className="secondary" onClick={() => { setAnswer(""); void providerAuth.cancel(login.id).catch(err => setError(String(err))); }}>取消登录</button>}
      {login.error && <p role="alert">{login.error}</p>}
    </div>}
    {busy && <p role="status">正在读取 provider / 认证状态…</p>}
    {catalog?.warning && <p role="alert">{catalog.warning}</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
