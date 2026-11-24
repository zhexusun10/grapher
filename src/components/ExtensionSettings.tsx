import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Puzzle, Plus, Trash2, RefreshCw, LockKeyhole, Globe, ExternalLink } from 'lucide-react';
import { t, localizeError } from '../i18n';
import { piExtensions, type ExtensionCatalog, type PiExtension } from '../services/piExtensions';
import { useDialogFocus } from '../hooks/useDialogFocus';
import './ExtensionSettings.css';

const WEB_SEARCH_ID = 'npm:pi-better-web-search';
const KEENABLE_API_KEYS_URL = 'https://docs.keenable.ai/api-keys';

export function ExtensionItem({ extension, disabled, onToggle, statusNote }: {
  extension: PiExtension; disabled: boolean; onToggle: (extension: PiExtension) => void; statusNote?: string;
}) {
  const bundledDescriptions: Record<string, string> = {
    'npm:pi-continuity': t('更稳健的循环工程：自动恢复意外的流式中断、消息截断、网络断连，以及 API 5 小时/每周额度限制。'),
    'npm:pi-simple-timeout': t('为 bash 工具提供可配置的默认超时（默认 180 秒），并在触发默认超时时明确标注；可通过 /timeout 随时调整或关闭。'),
    'npm:pi-better-web-search': t('支持已配置的专用搜索 API 和已认证的兼容 Provider；仅在有可用搜索接口时注册 web_search 工具。'),
  };
  const description = extension.bundled
    ? `${extension.source}${bundledDescriptions[extension.id] ? ` · ${bundledDescriptions[extension.id]}` : ''}`
    : `${extension.source} · ${extension.path}`;
  return <li className="extension-settings-row">
    <div>
      <strong>{extension.name}</strong>
      <code>{description}</code>
      {statusNote && <p className="extension-settings-status-note">{statusNote}</p>}
    </div>
    {extension.required ? <span className="extension-settings-required" role="img" aria-label={t('始终启用，不可移除')}>
      <LockKeyhole size={14} aria-hidden="true" />
    </span> : <button type="button" className="secondary" disabled={disabled} onClick={() => onToggle(extension)}
      aria-label={t('{0}扩展 {1}', extension.enabled ? t('移除') : t('添加'), extension.name)}>
      {extension.enabled ? <Trash2 size={14} /> : <Plus size={14} />}{extension.enabled ? t('移除') : t('添加')}
    </button>}
  </li>;
}

export function KeenablePublicDialog({ open, busy, onCancel, onEnableOnly, onUsePublic }: {
  open: boolean;
  busy: boolean;
  onCancel: () => void;
  onEnableOnly: () => void;
  onUsePublic: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const titleId = useId();
  const messageId = useId();
  const detailId = useId();
  const dialogRef = useDialogFocus<HTMLDivElement>({
    open,
    onClose: () => { if (!busy) onCancel(); },
    initialFocus: '.primary-btn',
  });

  if (!open) return null;

  const content = (
    <motion.div
      className="modal-backdrop confirm-backdrop extension-websearch-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.16, ease: 'easeOut' }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <motion.div
        className="confirm-dialog extension-websearch-dialog"
        ref={dialogRef}
        tabIndex={-1}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${messageId} ${detailId}`}
        initial={{ opacity: 0, scale: reduceMotion ? 1 : 0.96, y: reduceMotion ? 0 : 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: reduceMotion ? 1 : 0.97, y: reduceMotion ? 0 : 6 }}
        transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.16, 1, 0.3, 1] }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-header">
          <div className="confirm-icon-wrap">
            <Globe size={18} aria-hidden="true" />
          </div>
          <div className="confirm-texts">
            <h4 id={titleId}>{t('是否使用 Keenable 免费公共端点？')}</h4>
            <p id={messageId}>{t('启用 pi-better-web-search 后，可以直接使用 Keenable 的免费公共端点，无需配置 API Key 即可搜索和抓取网页。')}</p>
            <ul id={detailId} className="extension-websearch-notes">
              <li>{t('免费即用，且 Keenable 目前仍是综合效果最好的搜索 Provider。')}</li>
              <li>{t('公共端点的搜索信息公开，稳定性也不如私有 API Key，请勿发送敏感或隐私内容。')}</li>
              <li>
                {t('你也可以前往 Keenable 官网免费申请私有 API Key 进行替换：')}
                <a href={KEENABLE_API_KEYS_URL} target="_blank" rel="noopener noreferrer" className="extension-websearch-link">
                  docs.keenable.ai/api-keys
                  <ExternalLink size={12} aria-hidden="true" />
                </a>
              </li>
              <li>{t('选择使用公共端点后，一旦你配置了 Parallel、Keenable、Exa 或 Perplexity 任一专用搜索 API，系统会自动停止使用公共端点并切换到你的私有 API。')}</li>
            </ul>
          </div>
        </div>
        <div className="confirm-actions extension-websearch-actions">
          <button type="button" className="cancel-btn" disabled={busy} onClick={onCancel}>
            {t('取消')}
          </button>
          <button type="button" className="secondary-action-btn" disabled={busy} onClick={onEnableOnly}>
            {t('暂不使用，仅启用')}
          </button>
          <button type="button" className="primary-btn" disabled={busy} onClick={onUsePublic}>
            {t('使用免费公共端点')}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );

  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}

export function ExtensionSettings({ disabled = false }: { disabled?: boolean }) {
  const [catalog, setCatalog] = useState<ExtensionCatalog | undefined>(() => piExtensions.getCachedCatalog() ?? undefined);
  // A cached catalog already painted the real rows, so the card must not switch
  // back to a placeholder that is shorter than the content it replaces.
  const [busy, setBusy] = useState(() => !piExtensions.getCachedCatalog());
  const [error, setError] = useState('');
  const [pendingWebSearch, setPendingWebSearch] = useState<PiExtension | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    // Refresh behind a cached catalog: an unchanged response re-renders the same
    // rows, so the Settings pane keeps the height its reader already scrolled.
    piExtensions.catalog(true).then(value => { if (!cancelled) setCatalog(value); })
      .catch(error => { if (!cancelled) setError(String(error)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; mounted.current = false; };
  }, []);
  const update = async (extension?: PiExtension, options?: { keenablePublic?: boolean }) => {
    if (inFlight.current || extension?.required) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const value = extension
        ? await piExtensions.setEnabled(extension.id, !extension.enabled, options)
        : await piExtensions.catalog(true);
      if (mounted.current) setCatalog(value);
    } catch (error) {
      if (mounted.current) setError(String(error));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const handleToggle = (extension: PiExtension) => {
    if (inFlight.current || extension.required) return;
    if (extension.id === WEB_SEARCH_ID && !extension.enabled && !catalog?.webSearch?.hasDedicatedApi) {
      setPendingWebSearch(extension);
      return;
    }
    void update(extension);
  };
  const confirmWebSearchEnable = (keenablePublic: boolean) => {
    const extension = pendingWebSearch;
    setPendingWebSearch(null);
    if (extension) void update(extension, { keenablePublic });
  };
  const webSearchPublicActive = Boolean(catalog?.webSearch?.keenablePublic && !catalog?.webSearch?.hasDedicatedApi);
  const list = (enabled: boolean) => catalog?.extensions.filter(extension => extension.enabled === enabled).map(extension => (
    <ExtensionItem
      key={extension.id}
      extension={extension}
      disabled={busy || disabled}
      onToggle={handleToggle}
      statusNote={extension.id === WEB_SEARCH_ID && extension.enabled && webSearchPublicActive
        ? t('当前使用 Keenable 免费公共端点（配置 Parallel、Keenable、Exa 或 Perplexity API 后自动切换）')
        : undefined}
    />
  ));
  return <section className="settings-card extension-settings" aria-labelledby="extension-settings-title">
    <div className="settings-card-title">
      <Puzzle size={16} /><h4 id="extension-settings-title">{t('Pi 全局扩展')}</h4>
      <button type="button" className="icon-button" aria-label={t('刷新扩展')} disabled={busy || disabled} onClick={() => void update()}><RefreshCw size={14} /></button>
    </div>
    <p className="section-desc">{t('移除仅在 Grapher 中停用，不卸载全局扩展；检测到的外部全局扩展默认不挂载，需在待选列表中手动添加。')}</p>
    <p className="section-desc">{t('pi-trim 对所有角色生效；pi-continuity 与 pi-simple-timeout 默认启用，对 Planner、Node Agent 和 Merger 生效；pi-better-web-search 默认停用，需在设置中手动启用且仅对 Planner、Node Agent 生效；其他外部扩展默认不挂载，手动添加后仅对 Planner、Node Agent 生效，MCP 和 Skill 同样仅对 Planner、Node Agent 生效。')}</p>
    {catalog && <code className="extension-settings-directory">{catalog.globalDirectory}</code>}
    {busy && <p role="status" className="section-desc">{t('正在读取扩展…')}</p>}
    {error && <p role="alert" className="settings-language-error">{localizeError(error)}</p>}
    {catalog && <>
      <h5>{t('已启用')}</h5>
      <ul>{list(true)}</ul>
      {!catalog.extensions.some(extension => extension.enabled) && <p className="section-desc">{t('暂无已启用的扩展')}</p>}
      <h5>{t('待选扩展')}</h5>
      <ul>{list(false)}</ul>
      {!catalog.extensions.some(extension => !extension.enabled) && <p className="section-desc">{t('暂无待选扩展')}</p>}
    </>}
    <AnimatePresence>
      {pendingWebSearch !== null && (
        <KeenablePublicDialog
          key="keenable-public-dialog"
          open={true}
          busy={busy || disabled}
          onCancel={() => setPendingWebSearch(null)}
          onEnableOnly={() => confirmWebSearchEnable(false)}
          onUsePublic={() => confirmWebSearchEnable(true)}
        />
      )}
    </AnimatePresence>
  </section>;
}
