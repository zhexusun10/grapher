import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { t } from "../../i18n";
import { useDialogFocus } from "../../hooks/useDialogFocus";

export interface PreviewImageItem {
  src: string;
  alt?: string;
  name?: string;
}

interface ImagePreviewModalProps {
  images: readonly PreviewImageItem[];
  index: number | null;
  onChangeIndex?: (index: number) => void;
  onClose: () => void;
}

export function ImagePreviewModal({
  images,
  index,
  onChangeIndex,
  onClose,
}: ImagePreviewModalProps) {
  const open = index !== null && index >= 0 && index < images.length;
  const current = open ? images[index] : null;
  const total = images.length;
  const canNavigate = open && total > 1 && !!onChangeIndex;

  const dialogRef = useDialogFocus<HTMLDivElement>({
    open,
    onClose,
    initialFocus: ".image-preview-close-btn",
  });

  useEffect(() => {
    if (!canNavigate || index === null || !onChangeIndex) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        onChangeIndex((index - 1 + total) % total);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        onChangeIndex((index + 1) % total);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canNavigate, index, total, onChangeIndex]);

  if (!open || !current || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="image-preview-backdrop"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("图片预览")}
        tabIndex={-1}
        className="image-preview-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="image-preview-close-btn"
          onClick={onClose}
          aria-label={t("关闭预览")}
        >
          <X size={18} />
        </button>

        {canNavigate && index !== null && onChangeIndex && (
          <>
            <button
              type="button"
              className="image-preview-nav-btn prev"
              onClick={() => onChangeIndex((index - 1 + total) % total)}
              aria-label={t("上一张图片")}
            >
              <ChevronLeft size={20} />
            </button>
            <button
              type="button"
              className="image-preview-nav-btn next"
              onClick={() => onChangeIndex((index + 1) % total)}
              aria-label={t("下一张图片")}
            >
              <ChevronRight size={20} />
            </button>
          </>
        )}

        <img
          src={current.src}
          alt={current.alt || current.name || t("图片预览")}
          className="image-preview-full-img"
        />

        {(current.name || total > 1) && (
          <div className="image-preview-caption">
            {current.name ? <span className="image-preview-name">{current.name}</span> : null}
            {total > 1 && index !== null ? (
              <span className="image-preview-counter">
                {index + 1} / {total}
              </span>
            ) : null}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
