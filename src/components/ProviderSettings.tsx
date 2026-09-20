import React, { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
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
  Trash2,
  X,
  Search,
  ChevronDown,
  ChevronUp,
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
  const [actionSuccess, setActionSuccess] = useState("");
  const [confirmDeleteProvider, setConfirmDeleteProvider] = useState<ProviderInfo | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showProviders, setShowProviders] = useState(false);

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

  useEffect(() => {
    if (!confirmDeleteProvider) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirmDeleteProvider(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [confirmDeleteProvider]);

  async function logout(p: ProviderInfo) {
    setBusy(true);
    setError("");
    setActionSuccess("");
    try {
      await providerAuth.logout(p.id);
      if (model.startsWith(`${p.id}/`)) {
        onModel("");
      }
      if (providerFilter === p.id) {
        setProviderFilter("");
      }
      setCatalog((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          providers: prev.providers.map((prov) =>
            prov.id === p.id
              ? { ...prov, configured: false, authSource: null, authEnvVar: null }
              : prov
          ),
          models: prev.models.map((m) =>
            m.provider === p.id ? { ...m, available: false } : m
          ),
        };
      });
      await load();
      if (activeProvider?.id === p.id) {
        setLogin(undefined);
        setActiveProvider(null);
      }
      setActionSuccess(
        p.authSource === "env"
          ? `已在 Grapher 中屏蔽 ${p.name} (${p.id}) 的环境变量凭据。`
          : `已成功删除 ${p.name} (${p.id}) 的 API Key 凭据。`
      );
      setTimeout(() => {
        if (mounted.current) setActionSuccess("");
      }, 4500);
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

  const configuredProviders = providers.filter((p) => p.configured);
  const configuredCount = configuredProviders.length;
  const availableModels = catalog?.models.filter(
    (m) => m.available && (!providerFilter || m.provider === providerFilter)
  ) ?? [];

  return (
    <div className="provider-settings-container">
      {/* Top Model Setting & Presets */}
      <div className="model-quick-config">
        <div className="form-grid">
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

          <label className="form-field">
            <span>当前默认执行模型</span>
            <div className="model-input-wrapper">
              <input
                list="provider-models"
                value={model}
                onChange={(e) => onModel(e.target.value)}
                placeholder="例如: openai/gpt-4o 或 anthropic/claude-3-7-sonnet"
                className="model-text-input"
              />
              {model && (
                <button
                  type="button"
                  className="model-input-clear-btn"
                  onClick={() => onModel("")}
                  title="清空已选模型"
                >
                  <X size={13} />
                </button>
              )}
            </div>
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
        </div>

        {availableModels.length > 0 && (
          <div className="model-quick-chips">
            <span className="quick-chips-label">
              <Sparkles size={12} /> 快捷选用已可用模型:
            </span>
            <div className="quick-chips-list">
              {availableModels.slice(0, 8).map((m) => {
                const fullId = `${m.provider}/${m.id}`;
                const isSelected = model === fullId;
                return (
                  <button
                    key={fullId}
                    type="button"
                    className={`model-chip ${isSelected ? "active" : ""}`}
                    onClick={() => onModel(fullId)}
                    title={`点击选用: ${fullId}`}
                  >
                    {m.name || m.id}
                  </button>
                );
              })}
            </div>
          </div>
        )}
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
              凭证由本地 Pi 内核统一安全管理（保存在 <code>~/.grapher/pi-agent/auth.json</code>），Partitioner、Planner、Node Agent、Merger 天然共享，无需重复绑定。
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
              onChange={(e) => {
                setSearchQuery(e.target.value);
                if (e.target.value.trim() !== "") {
                  setShowProviders(true);
                }
              }}
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

      {actionSuccess && (
        <div className="login-status-alert success" style={{ marginBottom: "12px" }}>
          <CheckCircle2 size={15} />
          <span>{actionSuccess}</span>
        </div>
      )}

      {/* Active Configured Credentials Section */}
      {configuredProviders.length > 0 && (
        <div className="configured-credentials-card">
          <div className="configured-card-header">
            <div className="configured-title-group">
              <Key size={15} className="configured-key-icon" />
              <strong>已绑定的 API Key 凭据 ({configuredProviders.length})</strong>
            </div>
            <span className="configured-status-tag">
              <CheckCircle2 size={11} /> 运行环境就绪
            </span>
          </div>

          <div className="configured-list">
            {configuredProviders.map((p) => (
              <div key={p.id} className="configured-row">
                <div className="configured-info">
                  <div className="configured-name-wrap">
                    <span className="configured-name">{p.name}</span>
                    <code className="configured-id">{p.id}</code>
                  </div>
                  <span className={`configured-type-badge ${p.authSource === "env" ? "env-badge" : "stored-badge"}`}>
                    {p.authSource === "env"
                      ? `环境变量 (${p.authEnvVar || "ENV"})`
                      : "API Key 已保存"}
                  </span>
                </div>

                <div className="configured-actions">
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
                    title="重新输入以更新密钥"
                  >
                    <Key size={12} /> 修改 Key
                  </button>
                  <button
                    type="button"
                    className="card-action-btn logout-btn"
                    disabled={busy || pending}
                    onClick={() => setConfirmDeleteProvider(p)}
                    title="彻底删除 / 屏蔽此 API 凭据"
                  >
                    <Trash2 size={12} /> 删除 API Key
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

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
                {activeProvider?.configured && (
                  <button
                    type="button"
                    className="danger-outline-btn"
                    disabled={busy}
                    onClick={() => setConfirmDeleteProvider(activeProvider)}
                    title="从本地删除该凭据"
                  >
                    <Trash2 size={13} /> 删除当前凭据
                  </button>
                )}
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
      <div className="providers-grid-title" onClick={() => setShowProviders(!showProviders)} style={{ cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span>支持的 Provider 列表</span>
          <small>点击任意 Provider 可一键发起 <code>/login</code> 或管理凭据</small>
        </div>
        {showProviders ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </div>

      {showProviders && (
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
                      <Key size={12} /> 修改 Key
                    </button>
                    <button
                      type="button"
                      className="card-action-btn logout-btn"
                      disabled={busy || pending}
                      onClick={() => setConfirmDeleteProvider(p)}
                      title="移除本地已保存的 API Key 凭据"
                    >
                      <Trash2 size={12} /> 删除 Key
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
      )}

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

      {/* Custom In-App Deletion Confirmation Modal */}
      <AnimatePresence>
        {confirmDeleteProvider && (
          <motion.div
            key="confirm-delete-backdrop"
            className="confirm-delete-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            onClick={() => setConfirmDeleteProvider(null)}
          >
            <motion.div
              key="confirm-delete-modal"
              className="confirm-delete-modal"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="confirm-delete-title"
              initial={{ opacity: 0, scale: 0.94, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 8 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="confirm-delete-header">
                <div className="confirm-delete-icon-wrap">
                  <Trash2 size={18} />
                </div>
                <div className="confirm-delete-titles">
                  <h4 id="confirm-delete-title">确认移除该 API 凭据？</h4>
                  <p className="confirm-delete-subtitle">
                    {confirmDeleteProvider.authSource === "env"
                      ? "检测到该凭据来自系统环境变量，确认后将在 Grapher 中屏蔽"
                      : "确认后将从 Grapher 本地密钥库中彻底清除"}
                  </p>
                </div>
                <button
                  type="button"
                  className="confirm-close-btn"
                  onClick={() => setConfirmDeleteProvider(null)}
                  title="取消并关闭"
                >
                  <X size={15} />
                </button>
              </div>

              <div className="confirm-delete-body">
                <div className="confirm-delete-target-card">
                  <div className="target-provider-header">
                    <strong className="target-provider-name">
                      {confirmDeleteProvider.name}
                    </strong>
                    <code className="target-provider-id">
                      {confirmDeleteProvider.id}
                    </code>
                  </div>
                  <div className="target-provider-source">
                    凭据来源:{" "}
                    {confirmDeleteProvider.authSource === "env" ? (
                      <span className="source-tag env">
                        系统环境变量 ({confirmDeleteProvider.authEnvVar || "ENV"})
                      </span>
                    ) : (
                      <span className="source-tag local">本地 auth.json</span>
                    )}
                  </div>
                </div>

                <p className="confirm-delete-warning">
                  {confirmDeleteProvider.authSource === "env"
                    ? "屏蔽后，Grapher 不再向此 Provider 发送请求，相关模型将从可用列表中隐藏。您随时可在下方 Provider 列表中点击“登录”输入新密钥重新激活。"
                    : "清除后，该 Provider 下的所有模型将无法调用。您可以在下方列表中随时重新输入 API Key 绑定。"}
                </p>
              </div>

              <div className="confirm-delete-footer">
                <button
                  type="button"
                  className="secondary confirm-cancel-btn"
                  disabled={busy}
                  onClick={() => setConfirmDeleteProvider(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="danger-btn confirm-action-btn"
                  disabled={busy}
                  onClick={async () => {
                    const target = confirmDeleteProvider;
                    setConfirmDeleteProvider(null);
                    await logout(target);
                  }}
                >
                  <Trash2 size={13} /> 确认删除
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
