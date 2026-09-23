import React, { useState, useRef, useLayoutEffect, useEffect, useId, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  ArrowUp,
  Paperclip,
  X,
  LoaderCircle,
  Square,
  FileCode,
  FileText,
  File,
  Bot,
  Sparkles,
} from "lucide-react";
import { runtimeService } from "../../services/runtime";
import type { SkillItem, ImageAttachment } from "../../types";

export interface PromptBoxSubmitOptions {
  files?: File[];
  images?: ImageAttachment[];
  rawText?: string;
  displayText?: string;
  selectedTool?: string | null;
  mode?: "followUp" | "steer";
}

interface SuggestionCandidate {
  id: string;
  type: "file" | "skill";
  title: string;
  subtitle?: string;
  value: string;
  badge?: string;
  _score?: number;
}

export interface PromptBoxProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "onSubmit"> {
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLTextAreaElement> | any) => void;
  onSubmit?: (message: string, options?: PromptBoxSubmitOptions) => boolean | void | Promise<boolean>;
  placeholder?: string;
  disabled?: boolean;
  isBusy?: boolean;
  compact?: boolean;
  isExecuting?: boolean;
  isWorking?: boolean;
  onInterrupt?: () => void;
  planMode?: "auto" | "serial" | "graph";
  onPlanModeChange?: (mode: "auto" | "serial" | "graph") => void;
  onCancel?: () => void;
  layoutId?: string;
  className?: string;
  repository?: string;
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

const MODE_OPTIONS: Array<{ id: "auto" | "serial" | "graph"; label: string; title: string }> = [
  { id: "auto", label: "Auto", title: "智能路由：由 Partitioner 评估任务并自动选择单 Agent 或拓扑图架构" },
  { id: "serial", label: "Serial", title: "单 Agent：跳过 Partitioner，直接启动单 Agent 独立沙箱执行" },
  { id: "graph", label: "Graph", title: "拓扑图：跳过 Partitioner，直接启动 Planner 规划生成协作拓扑图" },
];

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
      isWorking = false,
      onInterrupt,
      planMode,
      onPlanModeChange,
      onCancel,
      layoutId,
      className = "",
      repository,
      ...restProps
    },
    forwardedRef
  ) => {
    const internalTextareaRef = useRef<HTMLTextAreaElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    const [internalValue, setInternalValue] = useState("");
    const [selectedImage, setSelectedImage] = useState<string | null>(null);
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const [isDraggingOver, setIsDraggingOver] = useState(false);
    const dragCounterRef = useRef(0);
    const selectedFileRef = useRef<File | null>(null);
    const [isPreparing, setIsPreparing] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const submittingRef = useRef(false);
    const pillLayoutId = useId();
    const composingRef = useRef(false);
    const compositionEndedAtRef = useRef(0);

    // 智能补全联想状态（@ 文件/智能体，/ Skills）
    const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([]);
    const [workspaceSkills, setWorkspaceSkills] = useState<SkillItem[]>([]);
    const [cursorPos, setCursorPos] = useState<number>(0);
    const [activeIndex, setActiveIndex] = useState<number>(0);
    const [dismissedTrigger, setDismissedTrigger] = useState<number | null>(null);
    const activeItemRef = useRef<HTMLDivElement | null>(null);
    const suggestionsListRef = useRef<HTMLDivElement | null>(null);

    const loadedRepoRef = useRef<string | null>(null);

    const loadCompletions = useCallback(async (force = false) => {
      try {
        const files = await runtimeService.listFiles(repository, force);
        const skills = await runtimeService.listSkills(repository, force);
        setWorkspaceFiles(files || []);
        setWorkspaceSkills(skills || []);
        loadedRepoRef.current = repository || "__default__";
      } catch (err) {
        console.warn("Failed to load completions:", err);
        setWorkspaceFiles([]);
      }
    }, [repository]);

    // 当切换工作区 repository 时，立即清空旧工作区文件，并强制刷新新工作区数据
    useEffect(() => {
      setWorkspaceFiles([]);
      loadCompletions(true);
    }, [repository, loadCompletions]);

    // 同步外部 value 变化（如编辑消息回填或清除）
    useEffect(() => {
      if (value !== undefined) {
        setInternalValue(value);
        if (value) {
          setTimeout(() => {
            internalTextareaRef.current?.focus();
          }, 40);
        }
      }
    }, [value]);

    const currentText = value !== undefined && onChange ? value : internalValue;
    const hasText = currentText.trim().length > 0;

    // 分析光标左侧文本中是否存在 @ 或 /
    const textBeforeCursor = currentText.slice(0, cursorPos);
    const atMatch = textBeforeCursor.match(/(?:^|\s)@([^\s@/]*)$/);
    const slashMatch = textBeforeCursor.match(/(?:^|\s)\/([^\s@/]*)$/);

    let triggerMode: "@" | "/" | null = null;
    let triggerQuery = "";
    let triggerStart = -1;

    if (atMatch && atMatch.index !== undefined) {
      triggerMode = "@";
      triggerQuery = atMatch[1];
      triggerStart = atMatch.index + (atMatch[0].startsWith("@") ? 0 : 1);
    } else if (slashMatch && slashMatch.index !== undefined) {
      triggerMode = "/";
      triggerQuery = slashMatch[1];
      triggerStart = slashMatch.index + (slashMatch[0].startsWith("/") ? 0 : 1);
    }

    const isDismissed = dismissedTrigger === triggerStart;
    const showSuggestions = triggerMode !== null && !isDismissed && !disabled && !isBusy;

    useEffect(() => {
      const currentKey = repository || "__default__";
      if (triggerMode === "@" && loadedRepoRef.current !== currentKey) {
        loadCompletions(true);
      }
      if (triggerMode === "/" && loadedRepoRef.current !== currentKey) {
        loadCompletions(true);
      }
    }, [triggerMode, repository, loadCompletions]);

    const suggestions = useMemo<SuggestionCandidate[]>(() => {
      if (!triggerMode) return [];

      if (triggerMode === "@") {
        const q = triggerQuery.toLowerCase();
        const items: SuggestionCandidate[] = [];

        // 项目工作区源码文件（严格排除技能内部文件与隐藏目录）
        const validFiles = workspaceFiles.filter((file) => {
          const lower = file.toLowerCase();
          return (
            !lower.startsWith(".agents/") &&
            !lower.startsWith(".pi/") &&
            !lower.startsWith(".git/") &&
            !lower.startsWith(".grapher/") &&
            !lower.startsWith(".gemini/") &&
            !lower.startsWith(".codex/") &&
            !lower.startsWith("node_modules/") &&
            !lower.startsWith("target/") &&
            !lower.startsWith("dist/") &&
            !lower.startsWith("build/")
          );
        });

        const scoredFiles = validFiles
          .map((file) => {
            const parts = file.split("/");
            const fileName = parts[parts.length - 1];
            const lowerName = fileName.toLowerCase();
            const lowerPath = file.toLowerCase();
            let score = 0;
            if (!q) {
              // 浅层根目录文件在无 query 时优先展示（如 package.json, README.md, src/App.tsx）
              score = Math.max(1, 20 - parts.length * 2);
            } else if (lowerName === q) {
              score = 100;
            } else if (lowerName.startsWith(q)) {
              score = 80;
            } else if (lowerName.includes(q)) {
              score = 50;
            } else if (lowerPath.includes(q)) {
              score = 30;
            }
            if (score > 0 && q) {
              score += Math.max(0, 5 - parts.length);
            }
            return { file, fileName, dir: parts.slice(0, -1).join("/"), score };
          })
          .filter((item) => item.score > 0);

        scoredFiles.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
        const topFiles = scoredFiles.slice(0, 30);

        for (const f of topFiles) {
          const ext = f.fileName.split(".").pop()?.toUpperCase() || "FILE";
          items.push({
            id: `file-${f.file}`,
            type: "file",
            title: f.fileName,
            subtitle: f.dir ? `${f.dir}/` : f.file,
            value: `@${f.file} `,
            badge: ext,
            _score: f.score,
          });
        }

        // 综合按评分排序
        items.sort((a, b) => (b._score ?? 0) - (a._score ?? 0));
        return items;
      }

      if (triggerMode === "/") {
        const q = triggerQuery.toLowerCase().replace(/^skill:/, "");
        const scoredSkills = workspaceSkills
          .map((skill) => {
            const lowerName = skill.name.toLowerCase();
            const lowerDesc = skill.description.toLowerCase();
            let score = 0;
            if (!q) {
              score = 10;
            } else if (lowerName === q) {
              score = 100;
            } else if (lowerName.startsWith(q)) {
              score = 80;
            } else if (lowerName.includes(q)) {
              score = 50;
            } else if (lowerDesc.includes(q)) {
              score = 30;
            }
            return { skill, score };
          })
          .filter((item) => item.score > 0);

        scoredSkills.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
        const topSkills = scoredSkills.slice(0, 25);

        return topSkills.map((s) => ({
          id: `skill-${s.skill.name}`,
          type: "skill",
          title: `/skill:${s.skill.name}`,
          subtitle: s.skill.description || "无描述",
          value: `/skill:${s.skill.name} `,
          badge: s.skill.scope === "workspace" ? "工作区" : "全局",
        }));
      }

      return [];
    }, [triggerMode, triggerQuery, workspaceFiles, workspaceSkills]);

    useEffect(() => {
      setActiveIndex(0);
    }, [triggerMode, triggerQuery]);

    useEffect(() => {
      if (activeItemRef.current) {
        activeItemRef.current.scrollIntoView({ block: "nearest" });
      }
    }, [activeIndex]);

    const applySuggestion = useCallback(
      (item: SuggestionCandidate) => {
        if (!item || triggerStart === -1) return;
        const before = currentText.slice(0, triggerStart);
        const after = currentText.slice(cursorPos);
        const nextText = `${before}${item.value}${after}`;
        const newCursor = before.length + item.value.length;

        setInternalValue(nextText);
        if (onChange) {
          onChange({ target: { value: nextText } } as any);
        }
        setDismissedTrigger(triggerStart);

        requestAnimationFrame(() => {
          const textarea = internalTextareaRef.current;
          if (textarea) {
            textarea.focus();
            textarea.setSelectionRange(newCursor, newCursor);
            setCursorPos(newCursor);
          }
        });
      },
      [currentText, triggerStart, cursorPos, onChange]
    );

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
      setInternalValue(e.target.value);
      setCursorPos(e.target.selectionStart || e.target.value.length);
      if (dismissedTrigger !== null && triggerStart !== dismissedTrigger) {
        setDismissedTrigger(null);
      }
      if (onChange) {
        onChange(e);
      }
    };

    const processIncomingFile = useCallback((file: File) => {
      selectedFileRef.current = file;
      setSelectedFile(file);
      setSelectedImage(null);
      if (file.type.startsWith("image/")) {
        const reader = new FileReader();
        reader.onload = () => {
          if (selectedFileRef.current === file) setSelectedImage(reader.result as string);
        };
        reader.readAsDataURL(file);
      }
    }, []);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      processIncomingFile(file);
      e.target.value = "";
    };

    const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (disabled || isBusy || isPreparing || isSubmitting) return;
      const items = e.clipboardData?.items;
      if (items) {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.kind === "file" && item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (file) {
              e.preventDefault();
              processIncomingFile(file);
              return;
            }
          }
        }
      }
      const files = e.clipboardData?.files;
      if (files && files.length > 0 && files[0].type.startsWith("image/")) {
        e.preventDefault();
        processIncomingFile(files[0]);
        return;
      }
      restProps.onPaste?.(e);
    };

    const handleDragEnter = (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current += 1;
      if (e.dataTransfer && e.dataTransfer.types.includes("Files")) {
        setIsDraggingOver(true);
      }
    };

    const handleDragOver = (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = "copy";
      }
    };

    const handleDragLeave = (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
      if (dragCounterRef.current === 0) {
        setIsDraggingOver(false);
      }
    };

    const handleDrop = (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = 0;
      setIsDraggingOver(false);
      if (disabled || isBusy || isPreparing || isSubmitting) return;
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        processIncomingFile(files[0]);
      }
    };

    const handleRemoveFile = (e: React.MouseEvent) => {
      e.stopPropagation();
      selectedFileRef.current = null;
      setSelectedImage(null);
      setSelectedFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    };

    const handleSubmitAction = async () => {
      const trimmed = currentText.trim();
      if ((!trimmed && !selectedFile) || disabled || isBusy || isPreparing || submittingRef.current) return;
      submittingRef.current = true;
      setIsSubmitting(true);
      let combinedPrompt = trimmed;
      let displayText = trimmed;
      const currentAttachment = selectedFile;
      let structuredImages: ImageAttachment[] | undefined = undefined;

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
            const commaIndex = dataUrl.indexOf(",");
            const base64Data = commaIndex !== -1 ? dataUrl.slice(commaIndex + 1) : dataUrl;
            structuredImages = [
              {
                type: "image",
                mimeType: currentAttachment.type || "image/png",
                data: base64Data,
                name: currentAttachment.name,
              },
            ];

            const promptText = trimmed || "请分析并处理此图片中的需求与内容。";
            combinedPrompt = `${promptText}\n\n[附件图片: ${currentAttachment.name}]`;
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

      try {
        if (onSubmit) {
          const accepted = await onSubmit(combinedPrompt, {
            files: currentAttachment ? [currentAttachment] : [],
            images: structuredImages,
            rawText: trimmed,
            displayText,
            mode: (isExecuting || isWorking) ? "steer" : undefined,
          });
          if (accepted === false) return;
        }

        setInternalValue("");
        selectedFileRef.current = null;
        setSelectedImage(null);
        setSelectedFile(null);
      } catch (error) {
        console.error("Failed to send message:", error);
      } finally {
        submittingRef.current = false;
        setIsSubmitting(false);
      }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (showSuggestions && suggestions.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setActiveIndex((prev) => (prev + 1) % suggestions.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setActiveIndex((prev) => (prev - 1 + suggestions.length) % suggestions.length);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          if (e.nativeEvent.isComposing || composingRef.current || e.keyCode === 229) return;
          e.preventDefault();
          if (suggestions[activeIndex]) {
            applySuggestion(suggestions[activeIndex]);
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setDismissedTrigger(triggerStart);
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        // IME candidate selection (including the final Enter) is not a send.
        if (e.nativeEvent.isComposing || composingRef.current || e.keyCode === 229 ||
            Date.now() - compositionEndedAtRef.current < 50) return;
        e.preventDefault();
        handleSubmitAction();
      } else if (e.key === "Escape") {
        onCancel?.();
      }
    };

    const canSubmit = (hasText || !!selectedFile) && !disabled && !isBusy && !isPreparing && !isSubmitting;

    return (
      <motion.div
        layoutId={layoutId || undefined}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        className={`prompt-box-container ${compact ? "compact" : "landing"} ${disabled ? "disabled" : ""} ${isDraggingOver ? "dragging-over" : ""} ${className}`}
        onClick={() => {
          if (!disabled && !isBusy) {
            internalTextareaRef.current?.focus();
          }
        }}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Drag Overlay visual indicator */}
        <AnimatePresence>
          {isDraggingOver && (
            <motion.div
              key="prompt-box-drag-overlay"
              className="prompt-box-drag-overlay"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={{ duration: 0.15 }}
            >
              <Paperclip size={20} className="prompt-box-drag-icon" />
              <span className="prompt-box-drag-text">释放以添加图片或文件附件</span>
            </motion.div>
          )}
        </AnimatePresence>
        {/* Floating Suggestion Popover above the PromptBox */}
        <AnimatePresence>
          {showSuggestions && (
            <motion.div
              key="prompt-box-suggestions-popover"
              className="prompt-box-suggestions-popover"
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.98 }}
              transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
              onMouseDown={(e) => e.preventDefault()}
            >
              <div className="prompt-box-suggestions-header">
                <span className="suggestions-header-title">
                  {triggerMode === "@" ? (
                    <>
                      <FileText size={13} className="header-icon-file" />
                      <span>提及项目文件</span>
                    </>
                  ) : (
                    <>
                      <Sparkles size={13} className="header-icon-skill" />
                      <span>Pi 技能与指令 (/skill:...)</span>
                    </>
                  )}
                </span>
                <span className="suggestions-header-hints">
                  <span className="key-hint">↑↓</span> 选择 <span className="key-hint">↵ / Tab</span> 确认 <span className="key-hint">Esc</span> 关闭
                </span>
              </div>
              <div className="prompt-box-suggestions-list" ref={suggestionsListRef}>
                {suggestions.length === 0 ? (
                  <div className="prompt-box-suggestions-empty">未找到匹配候选</div>
                ) : (
                  suggestions.map((item, idx) => {
                    const isActive = idx === activeIndex;
                    return (
                      <div
                        key={item.id}
                        className={`prompt-box-suggestion-item ${isActive ? "active" : ""}`}
                        onClick={() => applySuggestion(item)}
                        onMouseEnter={() => setActiveIndex(idx)}
                        ref={isActive ? activeItemRef : undefined}
                      >
                        <div className="suggestion-item-main">
                          <div className="suggestion-item-title-row">
                            <span className="suggestion-item-title">{item.title}</span>
                            {item.badge && (
                              <span className={`suggestion-item-badge ${item.type}`}>
                                {item.badge}
                              </span>
                            )}
                          </div>
                          {item.subtitle && (
                            <span className="suggestion-item-subtitle" title={item.subtitle}>
                              {item.subtitle}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Hidden File Input: allows text, code (ipynb, py, etc.), images, any single file */}
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          style={{ display: "none" }}
        />

        {/* Keep the preview mounted during exit so the box can shrink smoothly. */}
        <AnimatePresence initial={false}>
          {selectedFile && (
            <motion.div
              key="attachment-preview"
              className="prompt-box-attachment-slot"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ height: { duration: 0.26, ease: [0.16, 1, 0.3, 1] }, opacity: { duration: 0.16 } }}
            >
              {selectedFile.type.startsWith("image/") ? (
                <div className="prompt-box-image-preview-wrapper">
                  <div className="prompt-box-image-thumb">
                    {selectedImage && <img src={selectedImage} alt="上传附件预览" className="prompt-box-preview-img" />}
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
                </div>
              ) : (
                <div className="prompt-box-file-preview-wrapper">
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
                </div>
              )}
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
            onClick={(e) => {
              setCursorPos(e.currentTarget.selectionStart || 0);
              restProps.onClick?.(e);
            }}
            onKeyUp={(e) => {
              setCursorPos(e.currentTarget.selectionStart || 0);
              restProps.onKeyUp?.(e);
            }}
            onSelect={(e) => {
              setCursorPos(e.currentTarget.selectionStart || 0);
              restProps.onSelect?.(e);
            }}
            onFocus={(e) => {
              loadCompletions();
              setCursorPos(e.currentTarget.selectionStart || 0);
              restProps.onFocus?.(e);
            }}
            onBlur={(e) => {
              setDismissedTrigger(triggerStart);
              restProps.onBlur?.(e);
            }}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; compositionEndedAtRef.current = Date.now(); }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={placeholder}
            disabled={disabled || isBusy || isPreparing || isSubmitting}
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

          {/* Right Action Button: Mode Selector + Send/Interrupt Button */}
          <div className="prompt-box-right-actions">
            {planMode !== undefined && onPlanModeChange && (
              <div className="prompt-box-mode-selector" role="group" aria-label="执行规划模式">
                {MODE_OPTIONS.map((item) => {
                  const isSelected = planMode === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`prompt-box-mode-btn ${isSelected ? "active" : ""}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onPlanModeChange(item.id);
                      }}
                      title={item.title}
                    >
                      {isSelected && (
                        <motion.div
                          layoutId={`mode-pill-indicator-${pillLayoutId}`}
                          className="prompt-box-mode-pill-indicator"
                          transition={{
                            type: "spring",
                            stiffness: 520,
                            damping: 36,
                          }}
                        />
                      )}
                      <span className="prompt-box-mode-text">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            )}

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (isWorking && !hasText && !selectedFile) {
                  onInterrupt?.();
                } else {
                  handleSubmitAction();
                }
              }}
              disabled={isSubmitting || (isWorking ? (!hasText && !selectedFile && !onInterrupt) : !canSubmit)}
              className={`prompt-box-send-btn ${
                isWorking && !hasText && !selectedFile
                  ? "working active"
                  : canSubmit
                  ? "active"
                  : ""
              }`}
              title={
                isWorking
                  ? hasText || selectedFile
                    ? "发送以实时调整方向 (Steer)"
                    : "点击打断执行"
                  : "发送消息"
              }
              aria-label={
                isWorking
                  ? hasText || selectedFile
                    ? "发送以实时调整方向 (Steer)"
                    : "点击打断执行"
                  : "发送消息"
              }
            >
              {isWorking && !hasText && !selectedFile ? (
                <Square size={compact ? 8 : 10} className="prompt-box-stop-icon" />
              ) : isBusy || isPreparing || isSubmitting ? (
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
