import { t } from "../../i18n";
import React, { useState, useLayoutEffect, useRef, useId } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Check, X } from "lucide-react";
import { Graph, emptyGraph } from "../../types";
import { dialogVeilMotion, largeDialogMotion } from "./dialogMotion";
import { useDialogFocus } from "../../hooks/useDialogFocus";

interface EditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialGraph: Graph;
  busy: boolean;
  active: boolean;
  onSave: (graph: Graph) => void;
  onError: (err: string) => void;
}

export const EditorModal: React.FC<EditorModalProps> = React.memo(({
  isOpen,
  onClose,
  initialGraph,
  busy,
  active,
  onSave,
  onError,
}) => {
  const reduceMotion = useReducedMotion();
  const titleId = useId();
  const [editorText, setEditorText] = useState(() => JSON.stringify(initialGraph, null, 2));
  const wasOpen = useRef(isOpen);

  useLayoutEffect(() => {
    // Polling may deliver a new graph object while the user is typing.
    // Only opening a new editor session initializes its draft.
    if (isOpen && !wasOpen.current) setEditorText(JSON.stringify(initialGraph, null, 2));
    wasOpen.current = isOpen;
  }, [isOpen, initialGraph]);

  const dialogRef = useDialogFocus<HTMLElement>({
    open: isOpen,
    onClose: busy ? null : onClose,
    initialFocus: ".json-editor",
  });

  if (!isOpen) return null;

  const dialogMotion = largeDialogMotion(reduceMotion);
  const veilMotion = dialogVeilMotion(reduceMotion);

  return (
    <div
      className="modal-backdrop subtle-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      {/* Same light veil as Settings; it is inert so a click still lands on the
          backdrop and closes the editor. */}
      <motion.div className="modal-backdrop-tint" aria-hidden="true" {...veilMotion} />
      <motion.section
        className="modal wide surface-modal"
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy}
        {...dialogMotion}
      >
        <header>
          <h2 id={titleId}>{t("Graph IR · 编辑与编译")}</h2>
          <button type="button" className="icon-button" aria-label={t("关闭弹窗")} disabled={busy} onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <p className="modal-description">
          {t("使用语义化 name 声明节点与前驱后继依赖关系。保存后将通过 Rust 编译器校验；现有未审批图会在原对话中更新。")}</p>
        <textarea
          className="json-editor"
          aria-label="Graph JSON"
          value={editorText}
          onChange={(e) => setEditorText(e.target.value)}
          rows={16}
          spellCheck={false}
          readOnly={busy}
        />
        <footer>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => setEditorText(JSON.stringify(emptyGraph, null, 2))}
          >
            {t("清空模板")}</button>
          <button
            type="button"
            className="primary"
            disabled={busy || active}
            onClick={() => {
              try {
                const parsed = JSON.parse(editorText) as Graph;
                onSave(parsed);
              } catch (err) {
                onError(String(err));
              }
            }}
          >
            <Check size={14} />{t("校验并应用")}</button>
        </footer>
      </motion.section>
    </div>
  );
});

EditorModal.displayName = "EditorModal";

export default EditorModal;
