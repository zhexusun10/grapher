import React, { useEffect, useRef, useState } from "react";
import {
  Key,
  Globe,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Copy,
  Check,
  Eye,
  EyeOff,
  Sparkles,
  ShieldCheck,
  LogIn,
  LogOut,
  X,
  Search,
} from "lucide-react";
import {
  providerAuth,
  type LoginState,
  type ProviderCatalog,
  type ProviderInfo,
} from "../services/providerAuth";

function AuthLink({ url, label }: { url?: string; label?: string }) {
  if (!url) return null;
  try {
    if (!["https:", "http:"].includes(new URL(url).protocol)) return null;
  } catch {
    return null;
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
      className="provider-oauth-btn"
    >
      <ExternalLink size={14} />
      <span>{label || "在浏览器中打开授权页面"}</span>
    </a>
  );
}

const PRESET_MODELS = [
  { id: "qwen3.8-flash", label: "qwen3.8-flash", desc: "快速高性价比 (默认)" },
  { id: "anthropic/claude-3-7-sonnet", label: "Claude 3.7 Sonnet", desc: "高精度推理 (推荐)" },
  { id: "openai/gpt-4o", label: "GPT-4o", desc: "全能旗舰" },
  { id: "deepseek/deepseek-chat", label: "DeepSeek V3", desc: "超高性价比" },
];

export function ProviderSettings({
  model,
  onModel,
}: {
  model: string;
  onModel: (model: string) => void;
}) {
  const [catalog, setCatalog] = useState<ProviderCatalog>();
  const [providerFilter, setProviderFilter] = useState(
    model.includes("/") ? model.slice(0, model.indexOf("/")) : ""
  );
  const [activeProvider, setActiveProvider] = useState<ProviderInfo | null>(null);
  const [selectedMethod, setSelectedMethod] = useState<"api_key" | "oauth">("api_key");
  const [login, setLogin] = useState<LoginState>();
  const [answer, setAnswer] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  const mounted = useRef(false);
  const activeId = useRef<string | undefined>(undefined);

  async function load(refresh = false) {
    setBusy(true);
    setError("");
    try {
      const result = await providerAuth.catalog(refresh);
      if (mounted.current) {
        setCatalog(result);
        if (activeProvider) {
          const updated = result.providers.find((p) => p.id === activeProvider.id);
          if (updated) setActiveProvider(updated);
        }
      }
    } catch (err) {
      if (mounted.current) setError(String(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      if (activeId.current) void providerAuth.cancel(activeId.current).catch(() => {});
    };
  }, []);

  useEffect(() => {
    setAnswer("");
  }, [login?.prompt?.id]);

  useEffect(() => {
    if (!login || login.status !== "pending") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const next = await providerAuth.poll(login.id);
        if (stopped) return;
        setLogin(next);
        if (next.status !== "pending") {
          activeId.current = undefined;
          void load();
        } else {
          timer = setTimeout(poll, 700);
        }
      } catch (err) {
        if (!stopped) {
          setError(String(err));
          activeId.current = undefined;
          setLogin(undefined);
        }
      }
    };

    timer = setTimeout(poll, 300);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [login?.id, login?.status]);

  async function startLogin(p: ProviderInfo, method: "api_key" | "oauth") {
    setBusy(true);
    setError("");
    setLogin(undefined);
    setActiveProvider(p);
    setSelectedMethod(method);

    try {
      const next = await providerAuth.login(p.id, method);
      if (!mounted.current) {
        await providerAuth.cancel(next.id);
        return;
      }
      activeId.current = next.id;
      setLogin(next);
    } catch (err) {
      if (mounted.current) setError(String(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function respond() {
    if (!login?.prompt) return;
    const value = answer;
    setAnswer("");
    setBusy(true);
    setError("");
    try {
      const next = await providerAuth.respond(login.id, login.prompt.id, value);
      if (mounted.current) setLogin(next);
    } catch (err) {
      if (mounted.current) setError(String(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function logout(p: ProviderInfo) {
    setBusy(true);
    setError("");
    try {
      await providerAuth.logout(p.id);
      await load();
      if (activeProvider?.id === p.id) {
        setLogin(undefined);
        setActiveProvider(null);
      }
    } catch (err) {
      if (mounted.current) setError(String(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  function handleCancelLogin() {
    if (login) {
      void providerAuth.cancel(login.id).catch(() => {});
    }
    setLogin(undefined);
    setActiveProvider(null);
    setAnswer("");
  }

  function copyText(text: string) {
    navigator.clipboard.writeText(text);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  }

  const pending = login?.status === "pending";

  const providers = catalog?.providers ?? [];
  const filteredProviders = providers.filter(
    (p) =>
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.id.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const configuredCount = providers.filter((p) => p.configured).length;

  return (
    <div className="provider-settings-container">
      {/* Top Model Setting & Presets */}
      <div className="model-quick-config">
        <div className="form-grid">
          <label className="form-field">
            <span>当前默认执行模型</span>
            <input
              list="provider-models"
              value={model}
              onChange={(e) => onModel(e.target.value)}
              placeholder="例如: qwen3.8-flash 或 anthropic/claude-3-7-sonnet"
              className="model-text-input"
            />
            <datalist id="provider-models">
              {catalog?.models
                .filter((m) => !providerFilter || m.provider === providerFilter)
                .map((m) => (
                  <option
                    key={`${m.provider}/${m.id}`}
                    value={`${m.provider}/${m.id}`}
                  >
                    {m.name} · {m.api}
                    {m.available ? " · [可用]" : ""}
                  </option>
                ))}
            </datalist>
          </label>

          <label className="form-field">
            <span>模型所属 Provider 过滤</span>
            <select
              value={providerFilter}
              disabled={busy || pending}
              onChange={(e) => setProviderFilter(e.target.value)}
              className="provider-filter-select"
            >
              <option value="">全部 Provider</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.id}) {p.configured ? "✓ 已认证" : ""}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Quick Model Presets */}
        <div className="model-presets-row">
          <span className="preset-label">
            <Sparkles size={13} /> 快捷预设:
          </span>
          {PRESET_MODELS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`preset-pill ${model === item.id ? "active" : ""}`}
              onClick={() => onModel(item.id)}
              title={item.desc}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* Pi Auth Center Header */}
      <div className="pi-auth-header-card">
        <div className="pi-auth-title-group">
          <div className="pi-auth-icon-badge">
            <ShieldCheck size={18} />
          </div>
          <div>
            <div className="pi-auth-main-title">
              <h5>Pi 统一认证中心 (/login)</h5>
              <span className="auth-stat-badge">
                已就绪 {configuredCount} / {providers.length}
              </span>
            </div>
            <p className="section-desc pi-auth-desc">
              凭证由本地 Pi 内核统一加密管理（保存在 <code>~/.pi/agent/auth.json</code>），Partitioner、Planner、Subagent、Merger 天然共享，无需重复绑定。
            </p>
          </div>
        </div>

        <div className="pi-auth-actions-row">
          <div className="provider-search-box">
            <Search size={13} className="search-icon" />
            <input
              type="text"
              placeholder="搜索 Provider..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="secondary compact-btn"
            disabled={busy || pending}
            onClick={() => void load()}
            title="重新检测本地认证状态"
          >
            <RefreshCw size={13} className={busy ? "spin-icon" : ""} /> 刷新状态
          </button>
          <button
            type="button"
            className="secondary compact-btn"
            disabled={busy || pending}
            onClick={() => void load(true)}
            title="在线同步最新官方模型清单"
          >
            <Globe size={13} /> 同步最新模型
          </button>
        </div>
      </div>

      {/* Active Login Flow Modal/Drawer */}
      {(login || activeProvider) && (
        <div className="active-login-panel" aria-live="polite">
          <div className="active-login-header">
            <div className="active-login-title">
              <LogIn size={16} />
              <strong>
                登录与认证绑定: {activeProvider?.name || login?.provider}
              </strong>
            </div>
            <button
              type="button"
              className="icon-button-close"
              onClick={handleCancelLogin}
              title="取消 / 关闭登录面板"
            >
              <X size={15} />
            </button>
          </div>

          {/* Method Selector tabs if multiple methods available */}
          {activeProvider && activeProvider.methods.length > 1 && !login?.prompt && (
            <div className="auth-method-tabs">
              {activeProvider.methods.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`auth-method-tab ${selectedMethod === m.id ? "active" : ""}`}
                  disabled={busy || pending}
                  onClick={() => startLogin(activeProvider, m.id)}
                >
                  {m.id === "oauth" ? <Globe size={14} /> : <Key size={14} />}
                  <span>{m.name}</span>
                </button>
              ))}
            </div>
          )}

          {/* Events (OAuth URLs, Device Codes, Instructions) */}
          {login?.events && login.events.length > 0 && (
            <div className="login-events-container">
              {login.events.map((event, i) => (
                <div key={i} className="login-event-item">
                  {event.message && <p className="event-msg">{event.message}</p>}
                  {event.instructions && (
                    <p className="event-inst">{event.instructions}</p>
                  )}
                  {event.userCode && (
                    <div className="device-code-box">
                      <div className="device-code-label">设备授权码 (Device Code):</div>
                      <div className="device-code-value">
                        <code>{event.userCode}</code>
                        <button
                          type="button"
                          className="copy-btn"
                          onClick={() => copyText(event.userCode!)}
                          title="复制到剪贴板"
                        >
                          {copiedCode ? <Check size={14} /> : <Copy size={14} />}
                          <span>{copiedCode ? "已复制" : "复制"}</span>
                        </button>
                      </div>
                    </div>
                  )}
                  <AuthLink url={event.url || event.verificationUri} />
                  {event.links?.map((link, index) => (
                    <AuthLink key={index} url={link.url} label={link.label} />
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* Pending Pulse Waiter */}
          {pending && !login?.prompt && (
            <div className="pending-poll-indicator">
              <div className="pulse-dot"></div>
              <span>正在等待 Pi 内核完成授权校验，请在浏览器中确认...</span>
            </div>
          )}

          {/* Input Prompt (e.g. API Key or Select Option) */}
          {login?.prompt && (
            <div className="auth-prompt-form">
              <label htmlFor="auth-answer" className="prompt-label">
                <Key size={14} />
                <span>{login.prompt.message}</span>
              </label>

              {login.prompt.type === "select" ? (
                <select
                  id="auth-answer"
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  className="auth-input-field"
                >
                  <option value="">请选择选项...</option>
                  {login.prompt.options?.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                      {o.description ? ` — ${o.description}` : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="secret-input-wrap">
                  <input
                    id="auth-answer"
                    type={
                      login.prompt.type === "secret" ||
                      login.prompt.type === "manual_code"
                        ? showKey
                          ? "text"
                          : "password"
                        : "text"
                    }
                    autoComplete="off"
                    spellCheck={false}
                    value={answer}
                    placeholder={
                      login.prompt.placeholder ||
                      (login.prompt.type === "secret"
                        ? "输入 API Key (如 sk-...)"
                        : "请输入...")
                    }
                    onChange={(e) => setAnswer(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && answer.trim()) void respond();
                    }}
                    className="auth-input-field"
                  />
                  {(login.prompt.type === "secret" ||
                    login.prompt.type === "manual_code") && (
                    <button
                      type="button"
                      className="eye-toggle-btn"
                      onClick={() => setShowKey(!showKey)}
                      title={showKey ? "隐藏" : "显示"}
                    >
                      {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  )}
                </div>
              )}

              <div className="prompt-action-row">
                <button
                  type="button"
                  className="primary submit-key-btn"
                  disabled={busy || !answer.trim()}
                  onClick={() => void respond()}
                >
                  <Check size={14} /> 保存并绑定到 Pi
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={handleCancelLogin}
                >
                  取消
                </button>
              </div>
            </div>
          )}

          {/* Success Notification */}
          {login?.status === "complete" && (
            <div className="login-status-alert success">
              <CheckCircle2 size={16} />
              <span>✓ 认证成功！凭据已成功写入 Pi 本地认证库。</span>
            </div>
          )}

          {/* Error Notification */}
          {login?.error && (
            <div className="login-status-alert error">
              <AlertCircle size={16} />
              <span>{login.error}</span>
            </div>
          )}
        </div>
      )}

      {/* Provider List Grid */}
      <div className="providers-grid-title">
        <span>支持的 Provider 列表</span>
        <small>点击任意 Provider 可一键发起 <code>/login</code> 或管理凭据</small>
      </div>

      <div className="providers-card-grid">
        {filteredProviders.map((p) => {
          const isSelected = activeProvider?.id === p.id;
          return (
            <div
              key={p.id}
              className={`provider-card ${p.configured ? "configured" : ""} ${isSelected ? "selected" : ""}`}
            >
              <div className="provider-card-header">
                <div className="provider-brand-info">
                  <span className="provider-name">{p.name}</span>
                  <code className="provider-id">{p.id}</code>
                </div>
                <div
                  className={`provider-badge ${p.configured ? "badge-configured" : "badge-unconfigured"}`}
                >
                  {p.configured ? (
                    <>
                      <CheckCircle2 size={11} /> 已配置
                      {p.authType ? ` (${p.authType})` : ""}
                    </>
                  ) : (
                    "未配置"
                  )}
                </div>
              </div>

              <div className="provider-card-footer">
                {p.configured ? (
                  <div className="provider-card-actions">
                    <button
                      type="button"
                      className="card-action-btn reauth-btn"
                      disabled={busy || pending}
                      onClick={() => {
                        const defaultMethod =
                          p.methods.find((m) => m.id === "oauth")?.id ??
                          p.methods[0]?.id ??
                          "api_key";
                        void startLogin(p, defaultMethod as "api_key" | "oauth");
                      }}
                      title="重新输入密钥或刷新授权"
                    >
                      <RefreshCw size={12} /> 重新登录
                    </button>
                    <button
                      type="button"
                      className="card-action-btn logout-btn"
                      disabled={busy || pending}
                      onClick={() => void logout(p)}
                      title="移除本地已保存的凭据"
                    >
                      <LogOut size={12} /> 退出
                    </button>
                  </div>
                ) : (
                  <div className="provider-card-actions">
                    {p.methods.length > 0 ? (
                      <button
                        type="button"
                        className="card-action-btn login-btn"
                        disabled={busy || pending}
                        onClick={() => {
                          const defaultMethod =
                            p.methods.find((m) => m.id === "oauth")?.id ??
                            p.methods[0]?.id ??
                            "api_key";
                          void startLogin(p, defaultMethod as "api_key" | "oauth");
                        }}
                      >
                        <LogIn size={13} /> 登录 (/login)
                      </button>
                    ) : (
                      <span className="env-only-hint">由环境变量或系统配置</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {busy && (
        <div className="provider-status-loading">
          <RefreshCw size={14} className="spin-icon" />
          <span>正在与 Pi 内核通信，同步 Provider 状态...</span>
        </div>
      )}

      {catalog?.warning && (
        <div className="login-status-alert warning">
          <AlertCircle size={15} />
          <span>{catalog.warning}</span>
        </div>
      )}

      {error && (
        <div className="login-status-alert error">
          <AlertCircle size={15} />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
