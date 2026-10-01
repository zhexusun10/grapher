import { t } from "../../i18n";
import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import { motion } from "motion/react";
import { Check, X } from "lucide-react";
import { Graph, emptyGraph } from "../../types";

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
  const [editorText, setEditorText] = useState(() => JSON.stringify(initialGraph, null, 2));
  const wasOpen = useRef(isOpen);

  useLayoutEffect(() => {
    // Polling may deliver a new graph object while the user is typing.
    // Only opening a new editor session initializes its draft.
    if (isOpen && !wasOpen.current) setEditorText(JSON.stringify(initialGraph, null, 2));
    wasOpen.current = isOpen;
  }, [isOpen, initialGraph]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, busy]);

  if (!isOpen) return null;

  return (
    <motion.div
      className="modal-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <motion.section
        className="modal wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        initial={{ opacity: 0, scale: 0.95, y: 14 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 10 }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      >
        <header>
          <h2 id="modal-title">{t("Graph IR · 编辑与编译")}</h2>
          <button className="icon-button" aria-label={t("关闭弹窗")} onClick={onClose}>
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
        />
        <footer>
          <button
            type="button"
            className="secondary"
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
    </motion.div>
  );
});

EditorModal.displayName = "EditorModal";

export default EditorModal;
