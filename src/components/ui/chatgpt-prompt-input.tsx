"use client";

import React, { useState, useRef, useLayoutEffect, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  ArrowUp,
  Paperclip,
  Wrench,
  X,
  Search,
  Lightbulb,
  Code2,
  Globe,
  ImageIcon,
  LoaderCircle,
  Sparkles,
} from "lucide-react";

export interface ToolOption {
  id: string;
  name: string;
  shortName: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  extra?: string;
}

export const TOOL_OPTIONS: ToolOption[] = [
  { id: "searchWeb", name: "联网搜索与资料检索", shortName: "Search", icon: Search },
  { id: "thinkLonger", name: "深度思考与架构推演", shortName: "Think", icon: Lightbulb },
  { id: "writeCode", name: "编写与重构代码", shortName: "Code", icon: Code2 },
  { id: "deepResearch", name: "全库深度上下文检索", shortName: "Deep Search", icon: Globe, extra: "Beta" },
  { id: "createImage", name: "拓扑可视化图表生成", shortName: "Diagram", icon: ImageIcon },
];

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
      layoutId = "chatgpt-prompt-box",
      className = "",
      ...restProps
    },
    forwardedRef
  ) => {
    const internalTextareaRef = useRef<HTMLTextAreaElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const toolsRef = useRef<HTMLDivElement | null>(null);

    const [internalValue, setInternalValue] = useState("");
    const [selectedImage, setSelectedImage] = useState<string | null>(null);
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
    const [isToolsOpen, setIsToolsOpen] = useState(false);

    const currentText = value !== undefined ? value : internalValue;

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

    // Handle outside clicks to close tools menu
    useEffect(() => {
      const handleClickOutside = (e: MouseEvent) => {
        if (toolsRef.current && !toolsRef.current.contains(e.target as Node)) {
          setIsToolsOpen(false);
        }
      };
      if (isToolsOpen) {
        document.addEventListener("mousedown", handleClickOutside);
      }
      return () => {
        document.removeEventListener("mousedown", handleClickOutside);
      };
    }, [isToolsOpen]);

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
          selectedTool: selectedToolId,
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

    const canSubmit = (currentText.trim().length > 0 || !!selectedImage) && !disabled && !isBusy;
    const activeTool = selectedToolId ? TOOL_OPTIONS.find((t) => t.id === selectedToolId) : null;

    return (
      <motion.div
        layoutId={layoutId}
        transition={{ type: "spring", stiffness: 140, damping: 20 }}
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

            {/* Tools Menu Button (UI展示，暂搁置不连接后端真实功能) */}
            <div className="prompt-box-tools-wrap" ref={toolsRef}>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsToolsOpen((prev) => !prev);
                }}
                className={`prompt-box-tool-btn ${activeTool ? "has-active" : ""}`}
                title="探索工具（暂未连接功能）"
                aria-label="探索工具"
                disabled={disabled || isBusy}
              >
                <Wrench size={compact ? 13 : 15} />
                {!compact && <span>{activeTool ? activeTool.shortName : "Tools"}</span>}
              </button>

              {/* Tools Popover Menu */}
              <AnimatePresence>
                {isToolsOpen && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95, y: 6 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: 6 }}
                    transition={{ duration: 0.15 }}
                    className="prompt-box-tools-popover"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="prompt-box-tools-header">
                      <Sparkles size={13} />
                      <span>探索可用工具</span>
                      <small>(暂未连接后端功能)</small>
                    </div>
                    <div className="prompt-box-tools-list">
                      {TOOL_OPTIONS.map((tool) => {
                        const Icon = tool.icon;
                        const isSelected = selectedToolId === tool.id;
                        return (
                          <button
                            key={tool.id}
                            type="button"
                            className={`prompt-box-tool-item ${isSelected ? "selected" : ""}`}
                            onClick={() => {
                              setSelectedToolId(isSelected ? null : tool.id);
                              setIsToolsOpen(false);
                            }}
                          >
                            <Icon size={14} className="tool-icon" />
                            <span className="tool-name">{tool.name}</span>
                            {tool.extra && <span className="tool-extra">{tool.extra}</span>}
                          </button>
                        );
                      })}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Active tool badge */}
            {activeTool && (
              <div className="prompt-box-active-tool-tag">
                <activeTool.icon size={12} />
                <span>{activeTool.shortName}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedToolId(null);
                  }}
                  title="取消工具"
                >
                  <X size={11} />
                </button>
              </div>
            )}
          </div>

          {/* Right Action Button: Send Button ONLY (Voice button is removed) */}
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
                <ArrowUp size={compact ? 15 : 18} />
              )}
            </button>
          </div>
        </div>
      </motion.div>
    );
  }
);

PromptBox.displayName = "PromptBox";
