import React, { useState, useRef, useLayoutEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  ArrowUp,
  Paperclip,
  X,
  LoaderCircle,
  FileCode,
  FileText,
  File,
} from "lucide-react";

export interface PromptBoxSubmitOptions {
  files?: File[];
  rawText?: string;
  displayText?: string;
  selectedTool?: string | null;
  mode?: "followUp" | "steer";
}

export interface PromptBoxProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "onSubmit"> {
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLTextAreaElement> | any) => void;
  onSubmit?: (message: string, options?: PromptBoxSubmitOptions) => void;
  placeholder?: string;
  disabled?: boolean;
  isBusy?: boolean;
  compact?: boolean;
  isExecuting?: boolean;
  layoutId?: string;
  className?: string;
}

function getFileIcon(fileName: string) {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  const codeExts = [
    "py",
    "ipynb",
    "js",
    "jsx",
    "ts",
    "tsx",
    "json",
    "yaml",
    "yml",
    "sh",
    "bash",
    "zsh",
    "rs",
    "go",
    "cpp",
    "c",
    "h",
    "hpp",
    "java",
    "html",
    "css",
    "scss",
    "sql",
    "xml",
    "toml",
  ];
  if (codeExts.includes(ext)) {
    return <FileCode size={15} className="prompt-box-file-icon-code" />;
  }
  const textExts = ["txt", "md", "csv", "tsv", "log", "pdf", "doc", "docx", "rtf"];
  if (textExts.includes(ext)) {
    return <FileText size={15} className="prompt-box-file-icon-text" />;
  }
  return <File size={15} className="prompt-box-file-icon-generic" />;
}

function formatFileSize(bytes: number) {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getLanguageForExt(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  switch (ext) {
    case "py":
      return "python";
    case "ipynb":
      return "json";
    case "js":
      return "javascript";
    case "jsx":
      return "jsx";
    case "ts":
      return "typescript";
    case "tsx":
      return "tsx";
    case "json":
      return "json";
    case "md":
      return "markdown";
    case "html":
      return "html";
    case "css":
      return "css";
    case "sh":
    case "bash":
    case "zsh":
      return "bash";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "sql":
      return "sql";
    case "yaml":
    case "yml":
      return "yaml";
    default:
      return ext || "text";
  }
}

export const PromptBox = React.forwardRef<HTMLTextAreaElement, PromptBoxProps>(
  (
    {
      value,
      onChange,
      onSubmit,
      placeholder = "",
      disabled = false,
      isBusy = false,
      compact = false,
      isExecuting = false,
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
    const [isPreparing, setIsPreparing] = useState(false);

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
      if (!file) return;
      setSelectedFile(file);
      if (file.type.startsWith("image/")) {
        const reader = new FileReader();
        reader.onloadend = () => {
          setSelectedImage(reader.result as string);
        };
        reader.readAsDataURL(file);
      } else {
        setSelectedImage(null);
      }
      e.target.value = "";
    };

    const handleRemoveFile = (e: React.MouseEvent) => {
      e.stopPropagation();
      setSelectedImage(null);
      setSelectedFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    };

    const handleSubmitAction = async () => {
      const trimmed = currentText.trim();
      if ((!trimmed && !selectedFile) || disabled || isBusy || isPreparing) return;

      let combinedPrompt = trimmed;
      let displayText = trimmed;
      const currentAttachment = selectedFile;

      if (currentAttachment) {
        setIsPreparing(true);
        try {
          if (currentAttachment.type.startsWith("image/")) {
            let dataUrl = selectedImage;
            if (!dataUrl) {
              dataUrl = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result as string);
                reader.onerror = reject;
                reader.readAsDataURL(currentAttachment);
              });
            }
            const promptHeader = trimmed
              ? `${trimmed}\n\n`
              : `请查看并分析以下附件图片：${currentAttachment.name}\n\n`;
            combinedPrompt = `${promptHeader}---\n### 附件图片: ${currentAttachment.name}\n![${currentAttachment.name}](${dataUrl})`;
            displayText = trimmed
              ? `${trimmed} [图片: ${currentAttachment.name}]`
              : `[图片: ${currentAttachment.name}]`;
          } else {
            let fileContent = "";
            try {
              fileContent = await currentAttachment.text();
            } catch {
              fileContent = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result as string);
                reader.onerror = reject;
                reader.readAsText(currentAttachment);
              });
            }
            const lang = getLanguageForExt(currentAttachment.name);
            const promptHeader = trimmed
              ? `${trimmed}\n\n`
              : `请分析并处理以下附件文件：${currentAttachment.name}\n\n`;
            combinedPrompt = `${promptHeader}---\n### 附件文件: ${currentAttachment.name}\n\`\`\`${lang}\n${fileContent}\n\`\`\``;
            displayText = trimmed
              ? `${trimmed} [附件: ${currentAttachment.name}]`
              : `[附件: ${currentAttachment.name}]`;
          }
        } catch (err) {
          console.error("Failed to process attached file:", err);
        } finally {
          setIsPreparing(false);
        }
      }

      if (onSubmit) {
        onSubmit(combinedPrompt, {
          files: currentAttachment ? [currentAttachment] : [],
          rawText: trimmed,
          displayText,
          mode: isExecuting ? "steer" : undefined,
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

    const canSubmit = (hasText || !!selectedFile) && !disabled && !isBusy && !isPreparing;

    return (
      <motion.div
        layoutId={layoutId || undefined}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        className={`prompt-box-container ${compact ? "compact" : "landing"} ${className}`}
        onClick={() => internalTextareaRef.current?.focus()}
      >
        {/* Hidden File Input: allows text, code (ipynb, py, etc.), images, any single file */}
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          style={{ display: "none" }}
        />

        {/* Uploaded File / Image Preview */}
        <AnimatePresence>
          {selectedImage ? (
            <motion.div
              key="image-preview"
              initial={{ opacity: 0, scale: 0.85, y: -4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.85, y: -4 }}
              className="prompt-box-image-preview-wrapper"
            >
              <div className="prompt-box-image-thumb">
                <img src={selectedImage} alt="上传附件预览" className="prompt-box-preview-img" />
                <button
                  type="button"
                  onClick={handleRemoveFile}
                  className="prompt-box-image-remove-btn"
                  title="移除图片"
                  aria-label="移除图片"
                >
                  <X size={12} />
                </button>
              </div>
            </motion.div>
          ) : selectedFile ? (
            <motion.div
              key="file-preview"
              initial={{ opacity: 0, scale: 0.9, y: -4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: -4 }}
              className="prompt-box-file-preview-wrapper"
            >
              <div className="prompt-box-file-badge">
                <span className="prompt-box-file-icon">
                  {getFileIcon(selectedFile.name)}
                </span>
                <div className="prompt-box-file-info">
                  <span className="prompt-box-file-name" title={selectedFile.name}>
                    {selectedFile.name}
                  </span>
                  <span className="prompt-box-file-size">
                    {formatFileSize(selectedFile.size)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleRemoveFile}
                  className="prompt-box-file-remove-btn"
                  title="移除文件"
                  aria-label="移除文件"
                >
                  <X size={12} />
                </button>
              </div>
            </motion.div>
          ) : null}
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
            disabled={disabled || isBusy || isPreparing}
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
              title="添加文本、代码（.ipynb/.py等）或图片附件"
              aria-label="添加文本、代码或图片附件"
              disabled={disabled || isBusy || isPreparing}
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
              title="发送消息 (Enter)"
              aria-label="发送消息"
            >
              {isBusy || isPreparing ? (
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
