import React, { useState, useEffect } from "react";
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
  const [editorText, setEditorText] = useState("");

  useEffect(() => {
    if (isOpen) {
      setEditorText(JSON.stringify(initialGraph, null, 2));
    }
  }, [isOpen, initialGraph]);

  if (!isOpen) return null;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        className="modal wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <header>
          <h2 id="modal-title">Graph IR · 编辑与编译</h2>
          <button className="icon-button" aria-label="关闭弹窗" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <p className="modal-description">
          使用语义化 name 声明节点与前驱后继依赖关系。保存后将通过 Rust 编译器校验并创建待审批运行。
        </p>
        <textarea
          className="json-editor"
          aria-label="Graph JSON"
          value={editorText}
          onChange={(event) => setEditorText(event.target.value)}
          spellCheck={false}
        />
        <footer>
          <button
            type="button"
            className="secondary"
            onClick={() => setEditorText(JSON.stringify(emptyGraph, null, 2))}
          >
            清空模板
          </button>
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
            <Check size={14} />校验并应用
          </button>
        </footer>
      </section>
    </div>
  );
});

EditorModal.displayName = "EditorModal";

export default EditorModal;
