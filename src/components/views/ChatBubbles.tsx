import { t } from "../../i18n";
import React, { useEffect, useLayoutEffect, useRef, useState, useMemo } from "react";
import { ArrowUp, Check, Copy, Pencil, X } from "lucide-react";
import type { ChatMessageVersion, ImageAttachment, FileAttachment } from "../../types";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { useSmoothStreamText } from "../../hooks/useSmoothStreamText";
import { parseMessageAttachmentsAndText, AttachmentCard } from "../../utils/attachmentUtils";
import { ImagePreviewModal, type PreviewImageItem } from "../modals/ImagePreviewModal";
import { notifyTranscriptContentGrowth, notifyTranscriptFinalOutput, transcriptScrollParent } from "../../services/transcriptScroll";
import { copyTextToClipboard } from "../../services/externalLink";

export const StreamingAssistantBubble: React.FC<{ content: string; isStreaming: boolean }> = React.memo(
  ({ content, isStreaming }) => {
    const smoothText = useSmoothStreamText(content, isStreaming);
    const stillTyping = isStreaming || smoothText.length < content.length;
    const bubbleRef = useRef<HTMLDivElement>(null);
    const previousTextRef = useRef(smoothText);
    // Pin synchronously before paint (after MarkdownRenderer's child layout
    // effect updates the DOM) so line wraps never paint one frame unpinned and
    // pull the footer back up on the next frame.
    useLayoutEffect(() => {
      const textChanged = smoothText !== previousTextRef.current;
      previousTextRef.current = smoothText;
      if (!smoothText && !isStreaming) return;
      // A mounted bubble can keep revealing queued text after message_end.
      // Treat those actual changes as output, but not the initial mount of an
      // old row when the user scrolls through virtualized history.
      if (isStreaming || textChanged) notifyTranscriptFinalOutput(bubbleRef.current);
      else {
        const scroller = transcriptScrollParent(bubbleRef.current);
        if (scroller && (scroller.dataset.transcriptFollowing === "true" || scroller.dataset.transcriptPreparing === "true")) {
          notifyTranscriptContentGrowth(bubbleRef.current);
        }
      }
    }, [smoothText, isStreaming]);
    return <div ref={bubbleRef} style={{ display: "contents" }}>
      <MarkdownRenderer content={smoothText} isStreaming={stillTyping} />
    </div>;
  }
);
StreamingAssistantBubble.displayName = "StreamingAssistantBubble";

const USER_BUBBLE_COLLAPSE_CHARS = 12_000;
const USER_BUBBLE_COLLAPSE_LINES = 150;
const USER_BUBBLE_PREVIEW_CHARS = 6_000;
const USER_BUBBLE_PREVIEW_LINES = 80;
const USER_BUBBLE_FULL_EXPAND_LIMIT = 120_000;
const USER_BUBBLE_EXPAND_STEP_CHARS = 20_000;

function computeUserBubblePreviewEnd(text: string): number {
  if (text.length <= USER_BUBBLE_COLLAPSE_CHARS) {
    let lines = 0;
    let previewEnd = -1;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) {
        lines++;
        if (lines === USER_BUBBLE_PREVIEW_LINES) previewEnd = i;
        if (lines > USER_BUBBLE_COLLAPSE_LINES) {
          return previewEnd > 0 ? Math.min(previewEnd, USER_BUBBLE_PREVIEW_CHARS) : USER_BUBBLE_PREVIEW_CHARS;
        }
      }
    }
    return text.length;
  }
  const limit = Math.min(text.length, USER_BUBBLE_PREVIEW_CHARS);
  let lines = 0;
  for (let i = 0; i < limit; i++) {
    if (text.charCodeAt(i) === 10) {
      lines++;
      if (lines >= USER_BUBBLE_PREVIEW_LINES) return i;
    }
  }
  return limit;
}

export function EditableUserBubble({
  text,
  images,
  files,
  editing,
  draft,
  onDraftChange,
  onEdit,
  onCancel,
  onSend,
  disabled,
  versions: _versions,
  currentVersionIndex: _currentVersionIndex,
  onSwitchVersion: _onSwitchVersion,
}: {
  text: string;
  images?: ImageAttachment[];
  files?: FileAttachment[];
  editing: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onEdit?: () => void;
  onCancel: () => void;
  onSend: (value: string) => boolean | void | Promise<boolean | void>;
  disabled?: boolean;
  versions?: ChatMessageVersion[];
  currentVersionIndex?: number;
  onSwitchVersion?: (targetIndex: number) => void;
}) {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const compositionEndedAtRef = useRef(0);
  // Selecting the caret is only an entry behavior. Re-applying it whenever
  // `draft` changes would jump the caret to the end on every keystroke.
  const editingRef = useRef(false);
  const [copied, setCopied] = useState(false);
  // The confirmation outlives its 1.5s timer by one fade: `.copied` is what
  // keeps this hover-only button visible, so dropping the checkmark with it
  // showed the copy icon through the fade and, on a still-revealed card,
  // reverted it a beat before the button went away. `copyHold` keeps the
  // checkmark until the button has really faded out (`onCopyFadeEnd`).
  const [copyHold, setCopyHold] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [visibleChars, setVisibleChars] = useState<number | null>(null);
  const submittingRef = useRef(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const { cleanText, attachments, images: allImages } = useMemo(() => {
    return parseMessageAttachmentsAndText(text, files, images);
  }, [text, files, images]);

  const previewEnd = useMemo(() => computeUserBubblePreviewEnd(cleanText), [cleanText]);
  const isCollapsible = previewEnd < cleanText.length;

  useEffect(() => {
    setVisibleChars(null);
  }, [cleanText]);

  const effectiveLimit = !isCollapsible
    ? cleanText.length
    : (visibleChars ?? previewEnd);
  const isTruncated = effectiveLimit < cleanText.length;
  const displayedText = isTruncated ? `${cleanText.slice(0, effectiveLimit)}…` : cleanText;

  const previewImages = useMemo<PreviewImageItem[]>(() =>
    allImages.map((img, idx) => ({
      src: img.data.startsWith("data:") ? img.data : `data:${img.mimeType || "image/png"};base64,${img.data}`,
      alt: img.name || t("图片 {0}", idx + 1),
      name: img.name,
    })),
    [allImages]
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    const targetText = cleanText || text;
    if (!targetText) return;
    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
    }
    const onSuccess = () => {
      if (!mountedRef.current) return;
      setCopied(true);
      setCopyHold(true);
      copyTimeoutRef.current = setTimeout(() => {
        if (mountedRef.current) setCopied(false);
      }, 1500);
    };

    void copyTextToClipboard(targetText).then((ok) => {
      if (ok) onSuccess();
    }).catch(() => {});
  };

  // Only the fade-out ends the confirmation: the reveal rules (hover, focus
  // within the card) hand the button back at full opacity without a transition,
  // so a visible button never resets its icon. Editing swaps the button out
  // entirely, so it drops the held checkmark instead of restoring it later.
  const onCopyFadeEnd = (event: React.TransitionEvent<HTMLButtonElement>) => {
    if (event.propertyName !== "opacity") return;
    if (Number(getComputedStyle(event.currentTarget).opacity) !== 0) return;
    setCopyHold(false);
  };

  useEffect(() => {
    if (!editing) return;
    setCopied(false);
    setCopyHold(false);
  }, [editing]);

  const showCopied = copied || copyHold;

  useLayoutEffect(() => {
    if (!editing) {
      editingRef.current = false;
      return;
    }
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      const scrollH = textarea.scrollHeight;
      if (scrollH > 0) {
        textarea.style.height = `${scrollH}px`;
      }
      if (!editingRef.current) {
        textarea.focus();
        const end = textarea.value.length;
        textarea.setSelectionRange(end, end);
      }
    }
    editingRef.current = true;
  }, [editing, draft]);

  const submit = async () => {
    const value = draft.trim();
    if (!value || !isChanged || disabled || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onSend(value);
    } catch (error) {
      // The owner reports errors; retain the editable draft for retry.
      console.error("Failed to edit message:", error);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const beginEdit = () => {
    if (cleanText) {
      onDraftChange(cleanText);
    }
    onEdit?.();
  };

  const targetText = cleanText || text;
  const isChanged = draft.trim() !== targetText.trim();

  return (
    <div className={`chat-user-message-card-wrapper${editing ? " inline-editing" : ""}`}>
      <div className="chat-bubble-body">
        {editing ? (
          <div className="chat-bubble-actions">
            <button
              type="button"
              className="chat-bubble-action-btn"
              onClick={onCancel}
              disabled={submitting}
              aria-label={t("取消修改")}
            >
              <X size={14} />
            </button>
            {/* Always visible while editing: a button that appears only after
              the first keystroke reads as missing, and a hidden confirm next
              to the occlusion-prone bubble edge left users stuck. */}
            <button
              type="button"
              className="chat-bubble-action-btn send"
              onClick={submit}
              disabled={disabled || submitting || !isChanged || !draft.trim()}
              aria-label={t("回退并重试")}
            >
              <ArrowUp size={14} />
            </button>
          </div>
        ) : (
          <div className="chat-bubble-left-tools">
            <button
              type="button"
              className={`chat-message-copy-btn${copied ? " copied" : ""}`}
              onClick={handleCopy}
              onTransitionEnd={onCopyFadeEnd}
              aria-label={showCopied ? t("已复制") : t("复制消息")}
            >
              {showCopied ? <Check size={14} /> : <Copy size={14} />}
            </button>
            {onEdit ? (
              <button
                type="button"
                className="chat-message-edit-btn"
                onClick={beginEdit}
                disabled={disabled}
                aria-label={t("修改消息并回退重试")}
              >
                <Pencil size={14} />
              </button>
            ) : null}
          </div>
        )}
        <div className="chat-user-bubble-stack">
          {/* 附件卡片（完全复用与输入框一致的预览卡片） */}
          {attachments.length > 0 && (
            <div className="chat-user-attachments-stack">
              {attachments.map((att, idx) => (
                <AttachmentCard key={idx} file={att} />
              ))}
            </div>
          )}

          {/* 图片附件 */}
          {previewImages.length > 0 && (
            <div className="chat-user-images-preview">
              {previewImages.map((img, idx) => (
                <button
                  key={idx}
                  type="button"
                  className="chat-user-image-thumb"
                  onClick={() => setPreviewIndex(idx)}
                  aria-label={t("预览图片")}
                >
                  <img
                    src={img.src}
                    alt={img.alt}
                    className="chat-user-img"
                  />
                </button>
              ))}
            </div>
          )}

          {/* 用户气泡：有文字内容或正在编辑时呈现 */}
          {(cleanText || editing) ? (
            <div
              ref={bubbleRef}
              className={`chat-bubble-user${editing ? " editing" : ""}`}
            >
              {editing ? (
                <div className="chat-bubble-edit-grid">
                  <span className="chat-bubble-edit-mirror" aria-hidden="true">
                    {draft ? (draft.endsWith("\n") ? `${draft} ` : draft) : " "}
                  </span>
                  <textarea
                    ref={textareaRef}
                    className="chat-bubble-edit-textarea"
                    aria-label={t("修改消息内容")}
                    disabled={submitting}
                    value={draft}
                    onChange={(event) => onDraftChange(event.target.value)}
                    onCompositionStart={() => {
                      composingRef.current = true;
                    }}
                    onCompositionEnd={() => {
                      composingRef.current = false;
                      compositionEndedAtRef.current = Date.now();
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        if (event.nativeEvent.isComposing || composingRef.current || event.keyCode === 229) return;
                        event.stopPropagation();
                        if (!submittingRef.current) onCancel();
                      } else if (event.key === "Enter" && !event.shiftKey) {
                        if (
                          event.nativeEvent.isComposing ||
                          composingRef.current ||
                          event.keyCode === 229 ||
                          Date.now() - compositionEndedAtRef.current < 50
                        ) {
                          return;
                        }
                        event.preventDefault();
                        submit();
                      } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                        if (
                          event.nativeEvent.isComposing ||
                          composingRef.current ||
                          event.keyCode === 229 ||
                          Date.now() - compositionEndedAtRef.current < 50
                        ) {
                          return;
                        }
                        event.preventDefault();
                        submit();
                      }
                    }}
                    rows={1}
                  />
                </div>
              ) : (
                <>
                  {displayedText}
                  {isCollapsible ? (
                    <div className="chat-bubble-user-expand-bar">
                      {isTruncated ? (
                        <button
                          type="button"
                          className="chat-bubble-user-expand-btn"
                          onClick={() => {
                            if (cleanText.length <= USER_BUBBLE_FULL_EXPAND_LIMIT) {
                              setVisibleChars(cleanText.length);
                            } else {
                              setVisibleChars(Math.min(cleanText.length, effectiveLimit + USER_BUBBLE_EXPAND_STEP_CHARS));
                            }
                          }}
                        >
                          {cleanText.length <= USER_BUBBLE_FULL_EXPAND_LIMIT
                            ? t("展开全部（共 {0} 字符）", cleanText.length.toLocaleString())
                            : t("继续展开（已显示 {0} / {1} 字符）", effectiveLimit.toLocaleString(), cleanText.length.toLocaleString())}
                        </button>
                      ) : null}
                      {effectiveLimit > previewEnd ? (
                        <button
                          type="button"
                          className="chat-bubble-user-expand-btn"
                          onClick={() => setVisibleChars(null)}
                        >
                          {t("收起内容")}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </div>
      </div>
      <ImagePreviewModal
        images={previewImages}
        index={previewIndex}
        onChangeIndex={setPreviewIndex}
        onClose={() => setPreviewIndex(null)}
      />
    </div>
  );
}
