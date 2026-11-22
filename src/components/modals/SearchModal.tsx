import "./search-modal.css";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, useIsPresent, useReducedMotion } from "motion/react";
import { Loader2, MessageSquare, Search, X } from "lucide-react";
import { t, localizeError } from "../../i18n";
import { runtimeService } from "../../services/runtime";
import type { ConversationSearchMatch } from "../../services/apiContract.generated";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { formatManagedAttachmentDisplayLabel } from "../../utils/attachmentPath";
import { dialogVeilMotion, largeDialogMotion } from "./dialogMotion";

export interface SearchModalProps {
  repository: string;
  currentRunId?: string;
  archivedRunIds?: ReadonlySet<string>;
  runLabels?: Record<string, string>;
  onClose: () => void;
  onSelectMatch: (match: ConversationSearchMatch) => void;
}

const SEARCH_DEBOUNCE_MS = 80;

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
}

export function SearchModal({
  repository,
  currentRunId,
  archivedRunIds,
  runLabels,
  onClose,
  onSelectMatch,
}: SearchModalProps) {
  const reduceMotion = useReducedMotion();
  const isPresent = useIsPresent();
  const titleId = useId();
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const requestSeqRef = useRef(0);
  const debounceTimerRef = useRef<number | null>(null);
  const activeControllerRef = useRef<AbortController | null>(null);
  const dialogRef = useDialogFocus<HTMLElement>({
    open: true,
    onClose,
    initialFocus: ".workspace-search-input",
  });

  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<ConversationSearchMatch[]>([]);
  const [settledQuery, setSettledQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const hasRepository = Boolean(repository.trim());
  const trimmedQuery = query.trim();
  const shortcutLabel = useMemo(() => (isMacPlatform() ? "⌘G" : "Ctrl+G"), []);

  // Pre-warm the backend workspace search index as soon as the dialog opens so
  // subsequent keystrokes hit the in-memory index in ~1ms.
  useEffect(() => {
    if (!hasRepository) return;
    const controller = new AbortController();
    void runtimeService
      .searchConversations(repository, "", { warm: true }, controller.signal)
      .catch(() => {});
    return () => controller.abort();
  }, [hasRepository, repository]);

  const cancelPendingSearch = useCallback(() => {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (activeControllerRef.current) {
      activeControllerRef.current.abort();
      activeControllerRef.current = null;
    }
  }, []);

  const executeSearch = useCallback(
    async (nextQuery: string, signal: AbortSignal) => {
      const seq = ++requestSeqRef.current;
      if (!nextQuery || !hasRepository) {
        setMatches([]);
        setSettledQuery("");
        setLoading(false);
        setError("");
        setActiveIndex(0);
        return;
      }
      setLoading(true);
      setError("");
      try {
        const result = await runtimeService.searchConversations(
          repository,
          nextQuery,
          undefined,
          signal,
        );
        if (signal.aborted || seq !== requestSeqRef.current) return;
        // Deduplicate by runId defensively so each candidate is one conversation.
        const seen = new Set<string>();
        const conversations: ConversationSearchMatch[] = [];
        for (const item of result.matches) {
          if (!seen.has(item.runId)) {
            seen.add(item.runId);
            conversations.push(item);
          }
        }
        setMatches(conversations);
        setSettledQuery(nextQuery);
        setActiveIndex(0);
        setLoading(false);
      } catch (err) {
        if (signal.aborted || seq !== requestSeqRef.current) return;
        setLoading(false);
        setSettledQuery(nextQuery);
        setError(localizeError(err instanceof Error ? err.message : String(err)));
      }
    },
    [hasRepository, repository],
  );

  useEffect(() => {
    cancelPendingSearch();
    if (!trimmedQuery || !hasRepository) {
      requestSeqRef.current += 1;
      setMatches([]);
      setSettledQuery("");
      setLoading(false);
      setError("");
      setActiveIndex(0);
      return;
    }

    const controller = new AbortController();
    activeControllerRef.current = controller;
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null;
      void executeSearch(trimmedQuery, controller.signal);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelPendingSearch();
    };
  }, [trimmedQuery, hasRepository, executeSearch, cancelPendingSearch]);

  useEffect(() => {
    itemRefs.current = itemRefs.current.slice(0, matches.length);
  }, [matches.length]);

  useEffect(() => {
    const activeEl = itemRefs.current[activeIndex];
    if (activeEl && typeof activeEl.scrollIntoView === "function") {
      activeEl.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, matches.length]);

  const handleSelect = useCallback(
    (match: ConversationSearchMatch) => {
      onSelectMatch(match);
      onClose();
    },
    [onClose, onSelectMatch],
  );

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") {
      if (matches.length === 0) return;
      event.preventDefault();
      setActiveIndex((prev) => (prev + 1) % matches.length);
    } else if (event.key === "ArrowUp") {
      if (matches.length === 0) return;
      event.preventDefault();
      setActiveIndex((prev) => (prev - 1 + matches.length) % matches.length);
    } else if (event.key === "Enter") {
      if (!trimmedQuery || !hasRepository) return;
      event.preventDefault();
      // Never navigate to a stale result from an earlier query prefix.
      if (settledQuery !== trimmedQuery) {
        if (debounceTimerRef.current !== null) {
          cancelPendingSearch();
          const controller = new AbortController();
          activeControllerRef.current = controller;
          void executeSearch(trimmedQuery, controller.signal);
        }
        return;
      }
      if (loading || matches.length === 0) return;
      const target = matches[activeIndex] ?? matches[0];
      if (!target) return;
      handleSelect(target);
    }
  };

  const showPanel = useMemo(
    () => !hasRepository || Boolean(error) || (Boolean(trimmedQuery) && (matches.length > 0 || settledQuery === trimmedQuery)),
    [hasRepository, error, trimmedQuery, matches.length, settledQuery],
  );

  const dialogMotion = largeDialogMotion(reduceMotion);
  const veilMotion = dialogVeilMotion(reduceMotion);

  const content = (
    <div
      className="modal-backdrop subtle-backdrop workspace-search-backdrop"
      inert={!isPresent}
      style={!isPresent ? { pointerEvents: "none" } : undefined}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && isPresent) onClose();
      }}
    >
      <motion.div className="modal-backdrop-tint" aria-hidden="true" {...veilMotion} />
      <motion.section
        ref={dialogRef}
        className="modal surface-modal workspace-search-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        {...dialogMotion}
      >
        <h2 id={titleId} className="sr-only">
          {t("搜索当前工作区对话")}
        </h2>

        <div className="workspace-search-header">
          {loading ? (
            <Loader2 size={16} className="workspace-search-icon workspace-search-spin" aria-hidden="true" />
          ) : (
            <Search size={16} className="workspace-search-icon" aria-hidden="true" />
          )}
          <input
            ref={inputRef}
            type="text"
            className="workspace-search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={
              hasRepository
                ? t("搜索当前工作区对话…")
                : t("请先选择或打开一个工作区")
            }
            disabled={!hasRepository}
            aria-label={t("搜索当前工作区对话")}
            aria-controls={showPanel ? listboxId : undefined}
            aria-activedescendant={
              showPanel && matches[activeIndex] ? `${listboxId}-opt-${activeIndex}` : undefined
            }
            autoComplete="off"
            spellCheck={false}
            maxLength={500}
          />
          {query ? (
            <button
              type="button"
              className="workspace-search-clear"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              aria-label={t("清空搜索")}
            >
              <X size={14} />
            </button>
          ) : (
            <kbd className="workspace-search-kbd" aria-hidden="true">
              {shortcutLabel}
            </kbd>
          )}
        </div>

        {showPanel && (
          <div
            id={listboxId}
            className="workspace-search-results"
            role="listbox"
            aria-label={t("搜索结果")}
            aria-busy={loading}
          >
            {!hasRepository ? (
              <div className="workspace-search-empty">
                {t("尚未选择工作区")}
              </div>
            ) : error ? (
              <div className="workspace-search-empty is-error" role="alert">
                {t("搜索失败：{0}", error)}
              </div>
            ) : matches.length === 0 ? (
              <div className="workspace-search-empty" role="status">
                {t("未找到匹配的对话")}
              </div>
            ) : (
              matches.map((match, index) => {
                const isActive = index === activeIndex;
                const isCurrent = Boolean(currentRunId && match.runId === currentRunId);
                const isArchived = Boolean(archivedRunIds?.has(match.runId));
                const rawTitle = match.conversationTitle || runLabels?.[match.runId] || "";
                const title = rawTitle
                  ? formatManagedAttachmentDisplayLabel(rawTitle)
                  : `Graph ${match.runId.slice(0, 8)}`;

                return (
                  <button
                    key={match.runId}
                    id={`${listboxId}-opt-${index}`}
                    ref={(el) => {
                      itemRefs.current[index] = el;
                    }}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    className={`workspace-search-item${isActive ? " is-active" : ""}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => handleSelect(match)}
                  >
                    <div className="workspace-search-item-head">
                      <MessageSquare size={14} className="workspace-search-item-icon" aria-hidden="true" />
                      <span className="workspace-search-item-title" title={title}>
                        {title}
                      </span>
                      {isCurrent ? (
                        <span className="workspace-search-item-tag">{t("当前")}</span>
                      ) : isArchived ? (
                        <span className="workspace-search-item-tag">{t("已归档")}</span>
                      ) : null}
                    </div>
                    {(match.snippetBefore || match.snippetMatch || match.snippetAfter) && (
                      <div className="workspace-search-item-snippet">
                        {match.snippetBefore}
                        {match.snippetMatch && (
                          <mark className="workspace-search-highlight">{match.snippetMatch}</mark>
                        )}
                        {match.snippetAfter}
                      </div>
                    )}
                  </button>
                );
              })
            )}
          </div>
        )}
      </motion.section>
    </div>
  );
  return typeof document !== "undefined" ? createPortal(content, document.body) : content;
}

export default SearchModal;
