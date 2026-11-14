import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { motion, useIsPresent, useReducedMotion } from "motion/react";
import { Check, X } from "lucide-react";
import { t } from "../../i18n";
import { availableCatalogModels } from "../../modelConfig";
import { providerAuth } from "../../services/providerAuth";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { dialogVeilMotion, largeDialogMotion } from "./dialogMotion";

export function ScopedModelsModal({ onClose }: { onClose: () => void }) {
  const reduceMotion = useReducedMotion();
  const isPresent = useIsPresent();
  const titleId = useId();
  const catalog = useSyncExternalStore(providerAuth.subscribeCatalog, providerAuth.getCachedCatalog, () => null);
  const [changes, setChanges] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(!catalog);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const close = () => { if (!busyRef.current) onClose(); };
  const dialogRef = useDialogFocus<HTMLElement>({ open: true, onClose: close });
  useEffect(() => {
    mounted.current = true;
    void providerAuth.catalog(true).catch(error => {
      if (mounted.current) setError(String(error));
    }).finally(() => { if (mounted.current) setLoading(false); });
    return () => { mounted.current = false; };
  }, []);
  const hidden = new Set(catalog?.hiddenModels ?? catalog?.models.filter(model => model.hidden).map(model => `${model.provider}/${model.id}`) ?? []);
  const rows = useMemo(() => {
    const models = availableCatalogModels(catalog, true).map(model => ({ key: `${model.provider}/${model.id}`, name: model.name, available: true }));
    const seen = new Set(models.map(model => model.key));
    // Retired/unavailable hidden models remain manageable, never picker options.
    for (const key of catalog?.hiddenModels ?? []) if (!seen.has(key)) models.push({ key, name: key, available: false });
    return models;
  }, [catalog]);
  const save = async () => {
    if (busyRef.current) return;
    busyRef.current = true; setSaving(true); setError("");
    try {
      await providerAuth.setModelVisibility(Object.entries(changes).map(([model, hidden]) => ({ model, hidden })));
      if (mounted.current) onClose();
    } catch (error) {
      if (mounted.current) { setError(String(error)); setSaving(false); busyRef.current = false; }
    }
  };
  const dialogMotion = largeDialogMotion(reduceMotion);
  const veilMotion = dialogVeilMotion(reduceMotion);
  return createPortal(
    <div
      className="modal-backdrop subtle-backdrop scoped-models-backdrop"
      inert={!isPresent}
      style={!isPresent ? { pointerEvents: "none" } : undefined}
      onMouseDown={event => {
        if (event.target === event.currentTarget && isPresent && !busyRef.current) onClose();
      }}
    >
      <motion.div className="modal-backdrop-tint" aria-hidden="true" {...veilMotion} />
      <motion.section
        ref={dialogRef}
        className="modal surface-modal scoped-models-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={saving}
        tabIndex={-1}
        {...dialogMotion}
      >
        <header>
          <h2 id={titleId}>{t("全局可见模型")}</h2>
          <button type="button" className="icon-button" disabled={saving} onClick={close} aria-label={t("关闭弹窗")}><X size={18} /></button>
        </header>
        <p>{t("取消勾选会在所有会话的模型选择器和 Settings 中隐藏该模型。")}</p>
        <div className="scoped-model-list" aria-busy={loading}>
          {loading && <p role="status">{t("正在加载可用模型…")}</p>}
          {!loading && rows.length === 0 && <p>{t("暂无可用模型")}</p>}
          {rows.map(row => <label key={row.key} className="scoped-model-row">
            <input type="checkbox" disabled={saving} checked={!(changes[row.key] ?? hidden.has(row.key))}
              onChange={event => setChanges(previous => ({ ...previous, [row.key]: !event.target.checked }))} />
            <span><strong>{row.name || row.key}</strong><small>{row.key}{!row.available && ` · ${t("模型当前不可用")}`}</small></span>
          </label>)}
        </div>
        {error && <p role="alert">{error}</p>}
        <footer>
          <button type="button" className="settings-cancel-btn" disabled={saving} onClick={close}>{t("取消")}</button>
          <button type="button" className="primary" disabled={saving || loading || !catalog} aria-busy={saving} onClick={() => void save()}>
            {saving ? t("正在保存…") : <><Check size={14} />{t("保存")}</>}
          </button>
        </footer>
      </motion.section>
    </div>,
    document.body,
  );
}
