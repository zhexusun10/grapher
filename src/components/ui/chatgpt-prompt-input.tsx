import { t } from "../../i18n";
import React, { useState, useRef, useLayoutEffect, useEffect, useId, useCallback, useMemo } from "react";
import { motion, AnimatePresence, useIsPresent, useReducedMotion } from "motion/react";
import {
  ArrowUp,
  Paperclip,
  X,
  LoaderCircle,
  Square,
  FileText,
  Sparkles,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { runtimeService } from "../../services/runtime";
import { formatFileSize, getFileIcon } from "../../utils/attachmentUtils";
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

interface PromptBoxProps
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
  expandDelay?: number;
  onExpandedChange?: (expanded: boolean) => void;
  className?: string;
  repository?: string;
  runId?: string;
  node?: string;
}

export const PROMPT_BOX_RESIZE_DURATION = 0.3;
const COMPOSER_EASE = [0.22, 1, 0.36, 1] as const;

const MODE_OPTIONS: Array<{ id: "auto" | "serial" | "graph"; label: string }> = [
  { id: "auto", label: "Auto" },
  { id: "serial", label: "Serial" },
  { id: "graph", label: "Graph" },
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
      defaultValue = "",
      expandDelay = 0,
      onExpandedChange,
      className = "",
      repository,
      runId,
      node,
      ...restProps
    },
    forwardedRef
  ) => {
    const reduceMotion = useReducedMotion();
    const isPresent = useIsPresent();
    const containerRef = useRef<HTMLDivElement | null>(null);
    const flowRef = useRef<HTMLDivElement | null>(null);
    const resizeFromRef = useRef<number | null>(null);
    const resizeAnimationRef = useRef<Animation | null>(null);
    const hasMeasuredHeightRef = useRef(false);
    const internalTextareaRef = useRef<HTMLTextAreaElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const followInputEndRef = useRef(false);
    const revealInputEnd = useCallback(() => {
      const textarea = internalTextareaRef.current;
      if (followInputEndRef.current && textarea && document.activeElement === textarea &&
          textarea.selectionStart === textarea.value.length && textarea.selectionEnd === textarea.value.length) {
        textarea.scrollTop = textarea.scrollHeight;
      }
    }, []);

    const [internalValue, setInternalValue] = useState(() => String(defaultValue));
    const [isExpanded, setIsExpanded] = useState(false);
    const [canExpand, setCanExpand] = useState(false);
    const changeExpanded = (expanded: boolean) => {
      if (expanded === isExpanded) return;
      resizeFromRef.current = containerRef.current?.getBoundingClientRect().height ?? null;
      setIsExpanded(expanded);
      onExpandedChange?.(expanded);
    };
    const textareaId = useId();
    const [selectedImage, setSelectedImage] = useState<string | null>(null);
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const [isDraggingOver, setIsDraggingOver] = useState(false);
    const dragCounterRef = useRef(0);
    const selectedFileRef = useRef<File | null>(null);
    const attachmentIdRef = useRef<string | null>(null);
    const attachmentGenerationRef = useRef(0);
    const [isPreparing, setIsPreparing] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const submittingRef = useRef(false);
    const pillLayoutId = useId();
    const animateSendArrowRef = useRef(false);
    const composingRef = useRef(false);
    const compositionEndedAtRef = useRef(0);
    const mountedRef = useRef(true);
    const [attachmentError, setAttachmentError] = useState("");
    useEffect(() => {
      mountedRef.current = true;
      return () => { mountedRef.current = false; };
    }, []);

    useEffect(() => {
      selectedFileRef.current = null;
      attachmentIdRef.current = null;
      submittingRef.current = false;
      setSelectedFile(null);
      setSelectedImage(null);
      setAttachmentError("");
      setIsPreparing(false);
      setIsSubmitting(false);
      return () => { attachmentGenerationRef.current += 1; };
    }, [repository, runId, node]);

    // 智能补全联想状态（@ 文件/智能体，/ Skills）
    const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([]);
    const [workspaceSkills, setWorkspaceSkills] = useState<SkillItem[]>([]);
    const [cursorPos, setCursorPos] = useState<number>(0);
    const [activeIndex, setActiveIndex] = useState<number>(0);
    const [dismissedTrigger, setDismissedTrigger] = useState<{ start: number; query: string } | null>(null);
    const activeItemRef = useRef<HTMLDivElement | null>(null);
    const suggestionsListRef = useRef<HTMLDivElement | null>(null);

    const loadedRepoRef = useRef<string | null>(null);
    const loadingRepoRef = useRef<string | null>(null);
    const completionsGenerationRef = useRef(0);

    // 惰性加载：仅当出现 @ / / 触发词且当前工作区尚未加载时才拉取数据，
    // 避免首页挂载即全量遍历工作区文件与技能目录。
    const loadCompletions = useCallback(async (force = false) => {
      const key = repository || "__default__";
      if (!force && loadedRepoRef.current === key) return;
      if (loadingRepoRef.current === key) return;
      const generation = completionsGenerationRef.current;
      loadingRepoRef.current = key;
      try {
        const [files, skills] = await Promise.all([
          runtimeService.listFiles(repository, force), runtimeService.listSkills(repository, force),
        ]);
        if (generation !== completionsGenerationRef.current) return;
        setWorkspaceFiles(files || []);
        setWorkspaceSkills(skills || []);
        loadedRepoRef.current = key;
      } catch (err) {
        if (generation !== completionsGenerationRef.current) return;
        console.warn("Failed to load completions:", err);
        setWorkspaceFiles([]);
        setWorkspaceSkills([]);
      } finally {
        if (generation === completionsGenerationRef.current) loadingRepoRef.current = null;
      }
    }, [repository]);

    // 当切换工作区 repository 时，仅清空旧工作区缓存；数据推迟到触发词出现时再加载
    useEffect(() => {
      loadedRepoRef.current = null;
      loadingRepoRef.current = null;
      setWorkspaceFiles([]);
      setWorkspaceSkills([]);
      return () => { completionsGenerationRef.current += 1; };
    }, [repository, loadCompletions]);

    // 同步外部 value 变化（如编辑消息回填或清除）
    useEffect(() => {
      if (value === undefined) return;
      setInternalValue(value);
      // A user's own edit already has focus. Refocusing on every controlled
      // value update can disturb the browser's caret scroll after a paste.
      if (!value || document.activeElement === internalTextareaRef.current) return;
      const timer = setTimeout(() => internalTextareaRef.current?.focus({ preventScroll: true }), 40);
      return () => clearTimeout(timer);
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

    const isDismissed =
      dismissedTrigger !== null &&
      dismissedTrigger.start === triggerStart &&
      dismissedTrigger.query === triggerQuery;
    const showSuggestions = triggerMode !== null && !isDismissed && !disabled && !isBusy;

    // 当触发词位置变动或查询内容变化时，重置 dismissedTrigger
    useEffect(() => {
      if (
        dismissedTrigger !== null &&
        (triggerStart !== dismissedTrigger.start || triggerQuery !== dismissedTrigger.query)
      ) {
        setDismissedTrigger(null);
      }
    }, [triggerStart, triggerQuery, dismissedTrigger]);

    // 触发词（@ 或 /）首次出现时才加载当前工作区的补全数据（已加载则跳过）
    useEffect(() => {
      if (triggerMode !== null) {
        loadCompletions();
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
            value: `@${/[\s"\\]/.test(f.file) ? JSON.stringify(f.file) : f.file} `,
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
          subtitle: s.skill.description || t("无描述"),
          value: `/skill:${s.skill.name} `,
          badge: s.skill.scope === "workspace" ? t("工作区") : t("全局"),
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

        animateSendArrowRef.current = true;
        setInternalValue(nextText);
        if (onChange) {
          onChange({ target: { value: nextText } } as any);
        }
        setDismissedTrigger(triggerStart !== -1 ? { start: triggerStart, query: triggerQuery } : null);

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

    // Measure natural textarea heights, then animate the box. Preserve a reader's
    // scroll position, but keep a newly inserted end-of-draft caret visible at
    // the animated height, not just at the measured final height.
    const resizeTextarea = useCallback(() => {
      const textarea = internalTextareaRef.current;
      const box = containerRef.current;
      if (!textarea || !box) return;
      const explicitToggle = resizeFromRef.current !== null;
      if (isExpanded && !explicitToggle) {
        // Editing must not cancel an in-flight expansion (or its copy-exit delay).
        textarea.style.height = "100%";
        textarea.style.overflowY = "auto";
        revealInputEnd();
        if (!resizeAnimationRef.current) followInputEndRef.current = false;
        return;
      }
      const from = resizeFromRef.current ?? box.getBoundingClientRect().height;
      resizeFromRef.current = null;
      resizeAnimationRef.current?.cancel();
      resizeAnimationRef.current = null;
      box.removeAttribute("data-resizing");
      const scrollTop = textarea.scrollTop;
      if (isExpanded) {
        textarea.style.height = "100%";
        textarea.style.overflowY = "auto";
      } else {
        textarea.style.overflowY = "hidden";
        textarea.style.height = "auto";
        const maxHeight = compact ? 140 : 200;
        const minHeight = compact ? 36 : 46;
        const contentHeight = currentText.trim() ? textarea.scrollHeight : minHeight;
        setCanExpand(contentHeight >= maxHeight);
        textarea.style.height = `${Math.max(minHeight, Math.min(contentHeight, maxHeight))}px`;
        textarea.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
      }
      textarea.scrollTop = scrollTop;

      const target = box.getBoundingClientRect();
      const measuredBefore = hasMeasuredHeightRef.current;
      hasMeasuredHeightRef.current = true;
      if (!measuredBefore || reduceMotion || Math.abs(from - target.height) < 1) {
        revealInputEnd();
        followInputEndRef.current = false;
        return;
      }
      box.setAttribute("data-resizing", "");
      const animation = box.animate([
        { height: `${from}px` },
        { height: isExpanded ? "80dvh" : `${target.height}px` },
      ], {
        duration: PROMPT_BOX_RESIZE_DURATION * 1000,
        delay: explicitToggle && isExpanded ? expandDelay * 1000 : 0,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        fill: "backwards",
      });
      resizeAnimationRef.current = animation;
      // The backwards fill temporarily shrinks the textarea again. Restore the
      // end against this actual viewport before the first animated paint.
      revealInputEnd();
      animation.onfinish = () => {
        if (resizeAnimationRef.current !== animation) return;
        resizeAnimationRef.current = null;
        box.removeAttribute("data-resizing");
        revealInputEnd();
        followInputEndRef.current = false;
      };
    }, [compact, isExpanded, currentText, reduceMotion, expandDelay, revealInputEnd]);

    useLayoutEffect(() => {
      resizeTextarea();
    }, [currentText, resizeTextarea]);

    // The shared projection measures a zero-height bottom anchor, not the box's
    // changing top edge. Reserve the real height in flow so transcript padding
    // and landing layout still see the complete composer, including attachments
    // and every frame of an expanded-editor resize.
    useLayoutEffect(() => {
      const box = containerRef.current;
      const flow = flowRef.current;
      if (!layoutId || !box || !flow) return;
      const reserveHeight = () => {
        const height = `${box.getBoundingClientRect().height}px`;
        if (flow.style.height !== height) flow.style.height = height;
      };
      reserveHeight();
      const observer = new ResizeObserver(reserveHeight);
      observer.observe(box);
      return () => observer.disconnect();
    }, [layoutId]);

    // Wrapping can change when the window or workbench split is resized, too.
    useLayoutEffect(() => {
      const textarea = internalTextareaRef.current;
      if (!textarea) return;
      let width = textarea.getBoundingClientRect().width;
      const observer = new ResizeObserver(() => {
        const nextWidth = textarea.getBoundingClientRect().width;
        if (nextWidth !== width) {
          width = nextWidth;
          resizeTextarea();
        }
        revealInputEnd();
      });
      observer.observe(textarea);
      return () => observer.disconnect();
    }, [resizeTextarea, revealInputEnd]);

    useLayoutEffect(() => {
      const box = containerRef.current;
      return () => {
        resizeAnimationRef.current?.cancel();
        resizeAnimationRef.current = null;
        box?.removeAttribute("data-resizing");
      };
    }, []);

    const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const nextVal = e.target.value;
      const nextPos = e.target.selectionStart ?? nextVal.length;
      followInputEndRef.current = nextPos === nextVal.length && e.target.selectionEnd === nextVal.length;
      animateSendArrowRef.current = true;
      setInternalValue(nextVal);
      setCursorPos(nextPos);
      const textBefore = nextVal.slice(0, nextPos);
      const nextAt = textBefore.match(/(?:^|\s)@([^\s@/]*)$/);
      const nextSlash = textBefore.match(/(?:^|\s)\/([^\s@/]*)$/);
      const nextTriggerStart = nextAt && nextAt.index !== undefined
        ? nextAt.index + (nextAt[0].startsWith("@") ? 0 : 1)
        : nextSlash && nextSlash.index !== undefined
        ? nextSlash.index + (nextSlash[0].startsWith("/") ? 0 : 1)
        : -1;
      const nextTriggerQuery = nextAt ? nextAt[1] : nextSlash ? nextSlash[1] : "";
      if (
        dismissedTrigger !== null &&
        (nextTriggerStart !== dismissedTrigger.start || nextTriggerQuery !== dismissedTrigger.query)
      ) {
        setDismissedTrigger(null);
      }
      if (onChange) {
        onChange(e);
      }
    };

    const processIncomingFile = useCallback((file: File) => {
      setAttachmentError("");
      selectedFileRef.current = file;
      attachmentIdRef.current = crypto.randomUUID();
      setSelectedFile(file);
      setSelectedImage(null);
      // Selection is local only. Persist a collision-safe attachment on Send.
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
      if (submittingRef.current) return;
      setAttachmentError("");
      selectedFileRef.current = null;
      attachmentIdRef.current = null;
      setSelectedImage(null);
      setSelectedFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      // Never unlink a project file on Cancel. An earlier rejected/ambiguous
      // send may already have delivered its uniquely named attachment.
    };

    const handleSubmitAction = async () => {
      const trimmed = currentText.trim();
      if ((!trimmed && !selectedFile) || disabled || isBusy || isPreparing || submittingRef.current) return;
      submittingRef.current = true;
      setIsSubmitting(true);
      setAttachmentError("");

      const generation = attachmentGenerationRef.current;
      const isCurrent = () => mountedRef.current && generation === attachmentGenerationRef.current;
      const currentAttachment = selectedFile;
      let combinedPrompt = trimmed;

      if (currentAttachment) {
        const attachmentId = attachmentIdRef.current ??= crypto.randomUUID();
        let uploadedPath: string;
        setIsPreparing(true);
        try {
          if (!currentAttachment.type.startsWith("image/")) {
            try {
              await currentAttachment.text();
            } catch {
              await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result as string);
                reader.onerror = reject;
                reader.readAsText(currentAttachment);
              });
            }
          }
          if (!isCurrent()) return;
          // Revalidate delivery on every retry: the backend may have handed
          // this node to another workspace or published it since the last send.
          const uploaded = await runtimeService.writeWorkspaceFile(currentAttachment, repository, {
            runId, node, attachmentId,
          });
          if (!isCurrent()) return;
          uploadedPath = uploaded.path;
        } catch (err) {
          console.error("Failed to process attached file:", err);
          if (isCurrent()) {
            submittingRef.current = false;
            setAttachmentError(`${t("无法读取附件，请重新选择文件后重试。")} ${err instanceof Error ? err.message : String(err)}`);
            setIsSubmitting(false);
          }
          return;
        } finally {
          if (isCurrent()) setIsPreparing(false);
        }
        if (!isCurrent()) return;
        const path = uploadedPath;
        const fileMention = `@${/[\s"\\]/.test(path) ? JSON.stringify(path) : path}`;
        combinedPrompt = trimmed ? `${fileMention} ${trimmed}` : fileMention;
      }
      const displayText = combinedPrompt;
      let structuredImages: ImageAttachment[] | undefined = undefined;

      if (currentAttachment && currentAttachment.type.startsWith("image/")) {
        try {
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
        } catch {
          // 忽略图片转换异常
        }
      }

      try {
        if (!isCurrent()) return;
        if (onSubmit) {
          const accepted = await onSubmit(combinedPrompt, {
            files: currentAttachment ? [currentAttachment] : [],
            images: structuredImages,
            rawText: trimmed,
            displayText,
            mode: (isExecuting || isWorking) ? "steer" : undefined,
          });
          if (accepted === false || !isCurrent()) return;
        }

        animateSendArrowRef.current = true;
        setInternalValue("");
        changeExpanded(false);
        onChange?.({ target: { value: "" } } as React.ChangeEvent<HTMLTextAreaElement>);
        setCursorPos(0);
        setDismissedTrigger(null);
        selectedFileRef.current = null;
        setSelectedImage(null);
        setSelectedFile(null);
        attachmentIdRef.current = null;
      } catch (error) {
        console.error("Failed to send message:", error);
      } finally {
        if (isCurrent()) {
          submittingRef.current = false;
          setIsSubmitting(false);
        }
      }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(e.key)) {
        followInputEndRef.current = false;
      }
      restProps.onKeyDown?.(e);
      if (e.defaultPrevented) return;
      if (showSuggestions) {
        if (e.key === "Escape") {
          if (e.nativeEvent.isComposing || composingRef.current || e.keyCode === 229) return;
          e.preventDefault();
          e.stopPropagation();
          setDismissedTrigger({ start: triggerStart, query: triggerQuery });
          return;
        }
        if (suggestions.length > 0) {
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
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        // IME candidate selection (including the final Enter) is not a send.
        if (e.nativeEvent.isComposing || composingRef.current || e.keyCode === 229 ||
            Date.now() - compositionEndedAtRef.current < 50) return;
        e.preventDefault();
        handleSubmitAction();
      } else if (e.key === "Escape") {
        if (e.nativeEvent.isComposing || composingRef.current || e.keyCode === 229) return;
        if (isExpanded) {
          e.preventDefault();
          e.stopPropagation();
          changeExpanded(false);
        } else {
          onCancel?.();
        }
      }
    };

    const canSubmit = (hasText || !!selectedFile) && !disabled && !isBusy && !isPreparing && !isSubmitting;

    const prompt = (
      <motion.div
        ref={containerRef}
        initial={false}
        animate={{ opacity: 1 }}
        className={`prompt-box-container ${compact ? "compact" : "landing"} ${isExpanded ? "expanded" : ""} ${disabled ? "disabled" : ""} ${isDraggingOver ? "dragging-over" : ""} ${className}`}
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
              <span className="prompt-box-drag-text">{t("释放以添加图片或文件附件")}</span>
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
                      <span>{t("提及项目文件")}</span>
                    </>
                  ) : (
                    <>
                      <Sparkles size={13} className="header-icon-skill" />
                      <span>{t("Pi 技能与指令 (/skill:...)")}</span>
                    </>
                  )}
                </span>
                <button
                  type="button"
                  className="suggestions-header-close-btn"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDismissedTrigger({ start: triggerStart, query: triggerQuery });
                  }}
                  aria-label={t("关闭 (Esc)")}
                >
                  <span className="suggestions-header-hints">
                    <span className="key-hint">↑↓</span>{t(" 选择 ")}<span className="key-hint">↵ / Tab</span>{t(" 确认 ")}<span className="key-hint">Esc</span>{t(" 关闭")}
                  </span>
                  <X size={12} className="suggestions-close-icon" />
                </button>
              </div>
              <div className="prompt-box-suggestions-list" ref={suggestionsListRef}>
                {suggestions.length === 0 ? (
                  <div className="prompt-box-suggestions-empty">{t("未找到匹配候选")}</div>
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
                            <span className="suggestion-item-subtitle">
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
                    {selectedImage && <img src={selectedImage} alt={t("上传附件预览")} className="prompt-box-preview-img" />}
                    <button
                      type="button"
                      onClick={handleRemoveFile}
                      className="prompt-box-image-remove-btn"
                      aria-label={t("移除图片")}
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
                      <span className="prompt-box-file-name">
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
                      aria-label={t("移除文件")}
                    >
                      <X size={12} />
                    </button>
                  </div>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {attachmentError && <p role="alert" className="prompt-box-attachment-error">{attachmentError}</p>}
        {/* Textarea Input */}
        <div className="prompt-box-textarea-row">
          <textarea
            {...restProps}
            ref={(el) => {
              internalTextareaRef.current = el;
              if (typeof forwardedRef === "function") forwardedRef(el);
              else if (forwardedRef) forwardedRef.current = el;
            }}
            id={restProps.id ?? textareaId}
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
              if (e.currentTarget.selectionStart !== e.currentTarget.value.length ||
                  e.currentTarget.selectionEnd !== e.currentTarget.value.length) followInputEndRef.current = false;
              setCursorPos(e.currentTarget.selectionStart || 0);
              restProps.onSelect?.(e);
            }}
            onFocus={(e) => {
              setCursorPos(e.currentTarget.selectionStart || 0);
              restProps.onFocus?.(e);
            }}
            onPointerDown={(e) => {
              followInputEndRef.current = false;
              restProps.onPointerDown?.(e);
            }}
            onWheel={(e) => {
              followInputEndRef.current = false;
              restProps.onWheel?.(e);
            }}
            onTouchMove={(e) => {
              followInputEndRef.current = false;
              restProps.onTouchMove?.(e);
            }}
            onBlur={(e) => {
              followInputEndRef.current = false;
              if (triggerMode !== null) {
                setDismissedTrigger({ start: triggerStart, query: triggerQuery });
              }
              restProps.onBlur?.(e);
            }}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; compositionEndedAtRef.current = Date.now(); }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={placeholder}
            disabled={disabled || isBusy || isPreparing || isSubmitting}
            className="prompt-box-textarea"
          />
          {(canExpand || isExpanded) && (
            <button
              type="button"
              className="prompt-box-icon-btn prompt-box-expand-btn"
              aria-label={isExpanded ? t("收起输入框") : t("放大输入框")}
              title={isExpanded ? t("收起输入框") : t("放大输入框")}
              aria-expanded={isExpanded}
              aria-controls={restProps.id ?? textareaId}
              disabled={disabled || isBusy || isPreparing || isSubmitting}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation();
                changeExpanded(!isExpanded);
                internalTextareaRef.current?.focus({ preventScroll: true });
              }}
            >
              {isExpanded ? <Minimize2 size={compact ? 14 : 16} /> : <Maximize2 size={compact ? 14 : 16} />}
            </button>
          )}
        </div>

        {/* The shared bottom anchor owns navigation motion. Controls stay in
            normal flow: nested projections would add independent transforms
            that also compete with the buttons' CSS hover transitions. */}
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
              aria-label={t("添加文本、代码或图片附件")}
              disabled={disabled || isBusy || isPreparing || isSubmitting}
            >
              <Paperclip size={compact ? 15 : 18} />
            </button>
          </div>

          {/* Right Action Button: Mode Selector + Send/Interrupt Button */}
          <div className="prompt-box-right-actions">
            {planMode !== undefined && onPlanModeChange && (
              <div
                className="prompt-box-mode-selector"
                role="group"
                aria-label={t("执行规划模式")}
              >
                {MODE_OPTIONS.map((item) => {
                  const isSelected = planMode === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`prompt-box-mode-btn ${isSelected ? "active" : ""}`}
                      aria-pressed={isSelected}
                      data-label={item.label}
                      onClick={(e) => {
                        e.stopPropagation();
                        onPlanModeChange(item.id);
                      }}
                    >
                      {isSelected && (
                        <motion.div
                          layoutId={`mode-pill-indicator-${pillLayoutId}`}
                          layoutCrossfade={false}
                          initial={false}
                          aria-hidden="true"
                          className="prompt-box-mode-pill-indicator"
                          transition={{ layout: reduceMotion ? { duration: 0 } : {
                            type: "spring",
                            stiffness: 520,
                            damping: 36,
                          } }}
                        />
                      )}
                      <span className="prompt-box-mode-text">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {isWorking && (hasText || selectedFile) && onInterrupt && (
              <button
                type="button"
                className="prompt-box-icon-btn prompt-box-interrupt-btn"
                onClick={(event) => {
                  event.stopPropagation();
                  onInterrupt();
                }}
                disabled={isSubmitting || isPreparing}
                aria-label={t("点击打断执行")}
              >
                <Square size={compact ? 9 : 11} className="prompt-box-stop-icon" />
              </button>
            )}

            <button
              type="submit"
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
              aria-label={
                isWorking
                  ? hasText || selectedFile
                    ? t("发送以实时调整方向 (Steer)")
                    : t("点击打断执行")
                  : t("发送消息")
              }
            >
              {isWorking && !hasText && !selectedFile ? (
                <Square size={compact ? 8 : 10} className="prompt-box-stop-icon" />
              ) : isPreparing || isSubmitting ? (
                <LoaderCircle size={compact ? 14 : 16} className="prompt-box-spin" />
              ) : (
                <span
                  style={{
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    transform: `rotate(${hasText ? -90 : 0}deg)`,
                    transition: animateSendArrowRef.current && isPresent && !reduceMotion
                      ? "transform 0.22s cubic-bezier(0.16, 1, 0.3, 1)" : "none",
                  }}
                >
                  <ArrowUp size={compact ? 15 : 18} />
                </span>
              )}
            </button>
          </div>
        </div>
      </motion.div>
    );

    if (!layoutId) return prompt;
    return (
      <div ref={flowRef} className={`prompt-box-flow ${compact ? "compact" : ""}`}>
        <motion.div
          className="prompt-box-anchor"
          layoutId={layoutId}
          layout="position"
          layoutCrossfade={false}
          // Local height changes must not restart a navigation handoff.
          layoutDependency={isPresent ? textareaId : undefined}
          initial={false}
          transition={{ layout: { type: "tween", duration: reduceMotion || isExpanded ? 0 : PROMPT_BOX_RESIZE_DURATION, ease: COMPOSER_EASE } }}
        >
          {prompt}
        </motion.div>
      </div>
    );
  }
);

PromptBox.displayName = "PromptBox";
