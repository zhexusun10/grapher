"use client";

import React, { useState, useEffect, useRef } from "react";
import { Lightbulb, Globe, Paperclip, Send, LoaderCircle } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

const PLACEHOLDERS = [
  "为当前项目实现新功能模块并编写代码...",
  "重构数据传输层并优化系统状态流转...",
  "自动检测代码质量并编写单元测试覆盖...",
  "分析当前代码仓库架构并生成技术说明...",
  "排查潜在的并发冲突与边缘异常并修复...",
  "实现服务端接口与客户端的数据联调...",
];

export interface AIChatInputProps {
  value?: string;
  onChange?: (val: string) => void;
  onSubmit: (val: string, options: { think: boolean; deepSearch: boolean }) => void;
  disabled?: boolean;
  isBusy?: boolean;
  compact?: boolean;
  layoutId?: string;
  placeholderText?: string;
  activeProjectName?: string;
  activeProjectBranch?: string;
}

export const AIChatInput: React.FC<AIChatInputProps> = ({
  value,
  onChange,
  onSubmit,
  disabled = false,
  isBusy = false,
  compact = false,
  layoutId = "ai-chat-input-container",
  placeholderText,
  activeProjectName,
  activeProjectBranch,
}) => {
  const [internalValue, setInternalValue] = useState("");
  const inputValue = value !== undefined ? value : internalValue;
  const setInputValue = (v: string) => {
    if (onChange) onChange(v);
    else setInternalValue(v);
  };

  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const [showPlaceholder, setShowPlaceholder] = useState(true);
  const [isActive, setIsActive] = useState(false);
  const [thinkActive, setThinkActive] = useState(false);
  const [deepSearchActive, setDeepSearchActive] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Cycle placeholder text when input is inactive
  useEffect(() => {
    if (isActive || inputValue) return;

    const interval = setInterval(() => {
      setShowPlaceholder(false);
      setTimeout(() => {
        setPlaceholderIndex((prev) => (prev + 1) % PLACEHOLDERS.length);
        setShowPlaceholder(true);
      }, 400);
    }, 3200);

    return () => clearInterval(interval);
  }, [isActive, inputValue]);

  // Close input when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(event.target as Node)
      ) {
        if (!inputValue) setIsActive(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [inputValue]);

  const handleActivate = () => {
    if (!disabled && !isBusy) {
      setIsActive(true);
      inputRef.current?.focus();
    }
  };

  const handleSubmit = () => {
    const trimmed = inputValue.trim();
    if (!trimmed || disabled || isBusy) return;
    onSubmit(trimmed, { think: thinkActive, deepSearch: deepSearchActive });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const containerVariants: Record<string, any> = {
    collapsed: {
      height: compact ? 52 : 68,
      boxShadow: "0 4px 20px 0 rgba(0,0,0,0.24)",
      transition: { type: "spring" as const, stiffness: 120, damping: 18 },
    },
    expanded: {
      height: compact ? 98 : 124,
      boxShadow: "0 10px 36px 0 rgba(0,0,0,0.38)",
      transition: { type: "spring" as const, stiffness: 120, damping: 18 },
    },
  };

  const placeholderContainerVariants = {
    initial: {},
    animate: { transition: { staggerChildren: 0.02 } },
    exit: { transition: { staggerChildren: 0.012, staggerDirection: -1 } },
  };

  const letterVariants = {
    initial: {
      opacity: 0,
      filter: "blur(10px)",
      y: 8,
    },
    animate: {
      opacity: 1,
      filter: "blur(0px)",
      y: 0,
      transition: {
        opacity: { duration: 0.2 },
        filter: { duration: 0.35 },
        y: { type: "spring" as const, stiffness: 85, damping: 20 },
      },
    },
    exit: {
      opacity: 0,
      filter: "blur(10px)",
      y: -8,
      transition: {
        opacity: { duration: 0.18 },
        filter: { duration: 0.28 },
        y: { type: "spring" as const, stiffness: 85, damping: 20 },
      },
    },
  };

  const currentPlaceholder = placeholderText || PLACEHOLDERS[placeholderIndex];

  return (
    <motion.div
      ref={wrapperRef}
      layoutId={layoutId}
      className={`ai-chat-input-wrapper ${compact ? "compact" : "landing"}`}
      variants={containerVariants}
      animate={isActive || inputValue ? "expanded" : "collapsed"}
      initial="collapsed"
      onClick={handleActivate}
    >
      <div className="ai-chat-input-content">
        {/* Input Row */}
        <div className="ai-chat-row">
          <button
            className="ai-chat-icon-btn"
            title="附加参考文件或工作区上下文"
            type="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            <Paperclip size={compact ? 16 : 18} />
          </button>

          {/* Text Input & Placeholder */}
          <div className="ai-chat-input-area">
            {!compact && inputValue ? (
              <motion.div
                layoutId="user-query-content"
                style={{
                  position: "absolute",
                  left: 4,
                  top: 6,
                  pointerEvents: "none",
                  opacity: 0,
                  fontSize: 14,
                }}
              >
                {inputValue}
              </motion.div>
            ) : null}
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              className="ai-chat-text-input"
              onFocus={handleActivate}
              disabled={disabled || isBusy}
            />
            <div className="ai-chat-placeholder-overlay">
              <AnimatePresence mode="wait">
                {showPlaceholder && !isActive && !inputValue && (
                  <motion.span
                    key={currentPlaceholder}
                    className="ai-chat-placeholder-text"
                    variants={placeholderContainerVariants}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                  >
                    {currentPlaceholder.split("").map((char, i) => (
                      <motion.span
                        key={i}
                        variants={letterVariants}
                        style={{ display: "inline-block" }}
                      >
                        {char === " " ? "\u00A0" : char}
                      </motion.span>
                    ))}
                  </motion.span>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* 移除语音按钮，仅保留发送按钮 */}
          <button
            className={`ai-chat-send-btn ${inputValue.trim() && !disabled && !isBusy ? "active" : ""}`}
            title="发送目标并编译工作图 (Enter)"
            type="button"
            tabIndex={-1}
            disabled={!inputValue.trim() || disabled || isBusy}
            onClick={(e) => {
              e.stopPropagation();
              handleSubmit();
            }}
          >
            {isBusy ? <LoaderCircle size={compact ? 15 : 17} className="spin" /> : <Send size={compact ? 15 : 17} />}
          </button>
        </div>

        {/* Expanded Controls */}
        <motion.div
          className="ai-chat-controls"
          variants={{
            hidden: {
              opacity: 0,
              y: 12,
              pointerEvents: "none" as const,
              transition: { duration: 0.2 },
            },
            visible: {
              opacity: 1,
              y: 0,
              pointerEvents: "auto" as const,
              transition: { duration: 0.28, delay: 0.05 },
            },
          }}
          initial="hidden"
          animate={isActive || inputValue ? "visible" : "hidden"}
        >
          <div className="ai-chat-controls-row">
            {/* Think Toggle */}
            <button
              className={`ai-pill-btn ${thinkActive ? "active" : ""}`}
              title="深度思考与架构规划分析"
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setThinkActive((a) => !a);
              }}
            >
              <Lightbulb
                className={thinkActive ? "bulb-active" : ""}
                size={compact ? 13 : 15}
              />
              <span>Think</span>
            </button>

            {/* Deep Search Toggle */}
            <motion.button
              className={`ai-pill-btn ${deepSearchActive ? "active" : ""}`}
              title="全库深度上下文检索"
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setDeepSearchActive((a) => !a);
              }}
              initial={false}
              animate={{
                width: deepSearchActive ? (compact ? 110 : 124) : (compact ? 32 : 36),
                paddingLeft: deepSearchActive ? 8 : (compact ? 7 : 9),
              }}
            >
              <div className="pill-icon-wrap">
                <Globe size={compact ? 13 : 15} />
              </div>
              <motion.span
                className="pill-label"
                initial={false}
                animate={{
                  opacity: deepSearchActive ? 1 : 0,
                }}
              >
                Deep Search
              </motion.span>
            </motion.button>

            {/* 项目信息胶囊（如果在 landing 模式下且有活跃项目） */}
            {!compact && activeProjectName && (
              <span className="ai-chat-project-hint">
                目标项目: <strong>{activeProjectName}</strong>
                {activeProjectBranch && <code>{activeProjectBranch}</code>}
              </span>
            )}
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
};
