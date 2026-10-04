import { useEffect, useRef, useState } from 'react';
import { Puzzle, Plus, Trash2, RefreshCw, LockKeyhole } from 'lucide-react';
import { t, localizeError } from '../i18n';
import { piExtensions, type ExtensionCatalog, type PiExtension } from '../services/piExtensions';
import './ExtensionSettings.css';

export function ExtensionItem({ extension, disabled, onToggle }: {
  extension: PiExtension; disabled: boolean; onToggle: (extension: PiExtension) => void;
}) {
  const isContinuity = extension.bundled && extension.id === 'npm:pi-continuity';
  const description = isContinuity
    ? `${extension.source} · extension for more robust loop engineering`
    : extension.bundled ? extension.source : `${extension.source} · ${extension.path}`;
  return <li className="extension-settings-row">
    <div>
      <strong>{extension.name}</strong>
      <code title={isContinuity ? description : extension.path}>{description}</code>
    </div>
    {extension.required ? <span className="extension-settings-required" role="img" aria-label={t('始终启用，不可删除')} title={t('始终启用，不可删除')}>
      <LockKeyhole size={14} aria-hidden="true" />
    </span> : <button type="button" className="secondary" disabled={disabled} onClick={() => onToggle(extension)}
      aria-label={t('{0}扩展 {1}', extension.enabled ? t('删除') : t('添加'), extension.name)}>
      {extension.enabled ? <Trash2 size={14} /> : <Plus size={14} />}{extension.enabled ? t('删除') : t('添加')}
    </button>}
  </li>;
}

export function ExtensionSettings({ disabled = false }: { disabled?: boolean }) {
  const [catalog, setCatalog] = useState<ExtensionCatalog>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    piExtensions.catalog().then(value => { if (!cancelled) setCatalog(value); })
      .catch(error => { if (!cancelled) setError(String(error)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; mounted.current = false; };
  }, []);
  const update = async (extension?: PiExtension) => {
    if (inFlight.current || extension?.required) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const value = extension ? await piExtensions.setEnabled(extension.id, !extension.enabled) : await piExtensions.catalog();
      if (mounted.current) setCatalog(value);
    } catch (error) {
      if (mounted.current) setError(String(error));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const list = (enabled: boolean) => catalog?.extensions.filter(extension => extension.enabled === enabled).map(extension => (
    <ExtensionItem key={extension.id} extension={extension} disabled={busy || disabled} onToggle={extension => void update(extension)} />
  ));
  return <section className="settings-card extension-settings" aria-labelledby="extension-settings-title">
    <div className="settings-card-title">
      <Puzzle size={16} /><h4 id="extension-settings-title">{t('Pi 全局扩展')}</h4>
      <button type="button" className="icon-button" aria-label={t('刷新扩展')} disabled={busy || disabled} onClick={() => void update()}><RefreshCw size={14} /></button>
    </div>
    <p className="section-desc">{t('删除仅在 Grapher 中停用，不卸载全局扩展；可从待选列表随时加回。')}</p>
    <p className="section-desc">{t('pi-trim 对所有角色生效；其他扩展、MCP 和 Skill 仅对 Planner、Node Agent 生效。')}</p>
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
  </section>;
}
