import React, { useState, useRef, useLayoutEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ArrowUp, Paperclip, X, LoaderCircle } from "lucide-react";

export interface PromptBoxProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "onSubmit"> {
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLTextAreaElement> | any) => void;
  onSubmit?: (message: string, options?: { files?: File[]; selectedTool?: string | null }) => void;
  placeholder?: string;
  disabled?: boolean;
  isBusy?: boolean;
  compact?: boolean;
  layoutId?: string;
  className?: string;
}

export const PromptBox = React.forwardRef<HTMLTextAreaElement, PromptBoxProps>(
  (
    {
      value,
      onChange,
      onSubmit,
      placeholder = "描述你想完成的工作或输入指令...",
      disabled = false,
      isBusy = false,
      compact = false,
      layoutId,
      className = "",
      ...restProps
    },
    forwardedRef
  ) => {
    const internalTextareaRef = useRef<HTMLTextAreaElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    const [internalValue, setInternalValue] = useState("");
    const [selectedImage, setSelectedImage] = useState<string | null>(null);
    const [selectedFile, setSelectedFile] = useState<File | null>(null);

    const currentText = value !== undefined ? value : internalValue;
    const hasText = currentText.trim().length > 0;

    // Auto-adjust textarea height
    useLayoutEffect(() => {
      const textarea = internalTextareaRef.current;
      if (textarea) {
        textarea.style.height = "auto";
        const maxHeight = compact ? 140 : 200;
        const minHeight = compact ? 36 : 46;
        const targetHeight = Math.max(minHeight, Math.min(textarea.scrollHeight, maxHeight));
        textarea.style.height = `${targetHeight}px`;
      }
    }, [currentText, compact]);

    const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      if (onChange) {
        onChange(e);
      } else {
        setInternalValue(e.target.value);
      }
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file && file.type.startsWith("image/")) {
        setSelectedFile(file);
        const reader = new FileReader();
        reader.onloadend = () => {
          setSelectedImage(reader.result as string);
        };
        reader.readAsDataURL(file);
      }
      e.target.value = "";
    };

    const handleRemoveImage = (e: React.MouseEvent) => {
      e.stopPropagation();
      setSelectedImage(null);
      setSelectedFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    };

    const handleSubmitAction = () => {
      const trimmed = currentText.trim();
      if ((!trimmed && !selectedImage) || disabled || isBusy) return;

      if (onSubmit) {
        onSubmit(trimmed, {
          files: selectedFile ? [selectedFile] : [],
        });
      }

      if (value === undefined) {
        setInternalValue("");
      }
      setSelectedImage(null);
      setSelectedFile(null);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmitAction();
      }
    };

    const canSubmit = (hasText || !!selectedImage) && !disabled && !isBusy;

    return (
      <motion.div
        layoutId={layoutId || undefined}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        className={`prompt-box-container ${compact ? "compact" : "landing"} ${className}`}
        onClick={() => internalTextareaRef.current?.focus()}
      >
        {/* Hidden File Input */}
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          accept="image/*"
          style={{ display: "none" }}
        />

        {/* Uploaded Image Preview Thumbnail */}
        <AnimatePresence>
          {selectedImage && (
            <motion.div
              initial={{ opacity: 0, scale: 0.85, y: -4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.85, y: -4 }}
              className="prompt-box-image-preview-wrapper"
            >
              <div className="prompt-box-image-thumb">
                <img src={selectedImage} alt="上传附件预览" className="prompt-box-preview-img" />
                <button
                  type="button"
                  onClick={handleRemoveImage}
                  className="prompt-box-image-remove-btn"
                  title="移除图片"
                  aria-label="移除图片"
                >
                  <X size={12} />
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Textarea Input */}
        <div className="prompt-box-textarea-row">
          <textarea
            ref={(el) => {
              internalTextareaRef.current = el;
              if (typeof forwardedRef === "function") forwardedRef(el);
              else if (forwardedRef) forwardedRef.current = el;
            }}
            name="message"
            rows={1}
            value={currentText}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled || isBusy}
            className="prompt-box-textarea"
            {...restProps}
          />
        </div>

        {/* Controls / Actions Row */}
        <div className="prompt-box-actions-row">
          {/* Left Action Buttons */}
          <div className="prompt-box-left-actions">
            {/* Attach Image/File Button */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                fileInputRef.current?.click();
              }}
              className="prompt-box-icon-btn"
              title="添加图片或上下文附件"
              aria-label="添加图片或上下文附件"
              disabled={disabled || isBusy}
            >
              <Paperclip size={compact ? 15 : 18} />
            </button>
          </div>

          {/* Right Action Button: Send Button */}
          <div className="prompt-box-right-actions">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handleSubmitAction();
              }}
              disabled={!canSubmit}
              className={`prompt-box-send-btn ${canSubmit ? "active" : ""}`}
              title="发送并编译工作图 (Enter)"
              aria-label="发送消息"
            >
              {isBusy ? (
                <LoaderCircle size={compact ? 14 : 16} className="prompt-box-spin" />
              ) : (
                <motion.span
                  animate={{ rotate: hasText ? -90 : 0 }}
                  transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                  style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                >
                  <ArrowUp size={compact ? 15 : 18} />
                </motion.span>
              )}
            </button>
          </div>
        </div>
      </motion.div>
    );
  }
);

PromptBox.displayName = "PromptBox";
