import type { ImageAttachment } from "../types";
import { createUuid } from "../lib/uuid";

export interface RecalledMessage { text: string; images?: ImageAttachment[] }
export interface ComposerDraftAttachment {
  file: File;
  imagePreview: string | null;
  previewIsObjectUrl?: boolean;
  previewError?: boolean;
  attachmentId: string;
  uploadedPath?: string;
  uploadedContext?: { repository?: string; runId?: string; node?: string };
}
interface RecallState { revision: number; images: ImageAttachment[]; pending: boolean }
const EMPTY: RecallState = { revision: 0, images: [], pending: false };
const EMPTY_ATTACHMENTS: readonly ComposerDraftAttachment[] = [];

function revokePreview(attachment: ComposerDraftAttachment | null | undefined) {
  if (
    attachment?.previewIsObjectUrl &&
    attachment.imagePreview &&
    typeof URL !== "undefined" &&
    typeof URL.revokeObjectURL === "function"
  ) {
    URL.revokeObjectURL(attachment.imagePreview);
  }
}

/** Run-owned drafts outlive individual composers. Typing stays uncontrolled;
 * only recalls/attachment changes notify subscribers. Failed recalls retain
 * their request identity so retrying cannot clear a newer queue. */
export class ComposerDrafts extends Map<string, string> {
  private recalls = new Map<string, RecallState>();
  private attachmentLists = new Map<string, ComposerDraftAttachment[]>();
  private listeners = new Set<() => void>();
  private requests = new Map<string, { id: string; promise?: Promise<void> }>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private notify() {
    for (const listener of this.listeners) listener();
  }
  recall = (key: string): RecallState => this.recalls.get(key) ?? EMPTY;
  attachments = (key: string): readonly ComposerDraftAttachment[] => this.attachmentLists.get(key) ?? EMPTY_ATTACHMENTS;
  attachment = (key: string): ComposerDraftAttachment | null => this.attachmentLists.get(key)?.[0] ?? null;
  private update(key: string, patch: Partial<RecallState>) {
    this.recalls.set(key, { ...this.recall(key), ...patch });
    this.notify();
  }
  setImages(key: string, images: ImageAttachment[]) { this.update(key, { images }); }
  setAttachments(key: string, next: readonly ComposerDraftAttachment[], options?: { revokeReplaced?: boolean }) {
    const prev = this.attachmentLists.get(key) ?? [];
    const shouldRevoke = options?.revokeReplaced !== false;
    if (shouldRevoke && prev.length > 0) {
      const retainedUrls = new Set(next.map(item => item.imagePreview).filter(Boolean));
      for (const old of prev) {
        if (!old.imagePreview || !retainedUrls.has(old.imagePreview)) {
          revokePreview(old);
        }
      }
    }
    if (next.length > 0) {
      this.attachmentLists.set(key, [...next]);
    } else if (!this.attachmentLists.delete(key)) {
      return;
    }
    this.notify();
  }
  addAttachments(key: string, items: readonly ComposerDraftAttachment[]) {
    if (items.length === 0) return;
    const prev = this.attachmentLists.get(key) ?? [];
    this.attachmentLists.set(key, [...prev, ...items]);
    this.notify();
  }
  updateAttachment(key: string, attachmentId: string, patch: Partial<ComposerDraftAttachment>) {
    const prev = this.attachmentLists.get(key);
    if (!prev) return;
    const index = prev.findIndex(item => item.attachmentId === attachmentId);
    if (index === -1) return;
    const current = prev[index];
    const updated: ComposerDraftAttachment = { ...current, ...patch };
    if (current.imagePreview && current.imagePreview !== updated.imagePreview) {
      revokePreview(current);
    }
    const next = [...prev];
    next[index] = updated;
    this.attachmentLists.set(key, next);
    this.notify();
  }
  removeAttachment(key: string, attachmentId: string, options?: { revoke?: boolean }): ComposerDraftAttachment | null {
    const prev = this.attachmentLists.get(key);
    if (!prev) return null;
    const index = prev.findIndex(item => item.attachmentId === attachmentId);
    if (index === -1) return null;
    const removed = prev[index];
    if (options?.revoke !== false) revokePreview(removed);
    const next = prev.filter((_, i) => i !== index);
    if (next.length > 0) this.attachmentLists.set(key, next);
    else this.attachmentLists.delete(key);
    this.notify();
    return removed;
  }
  moveAttachments(fromKey: string, toKey: string) {
    if (fromKey === toKey) return;
    const source = this.attachmentLists.get(fromKey);
    if (!source || source.length === 0) return;
    const target = this.attachmentLists.get(toKey) ?? [];
    this.attachmentLists.set(toKey, [...target, ...source]);
    this.attachmentLists.delete(fromKey);
    this.notify();
  }
  setAttachment(key: string, attachment: ComposerDraftAttachment | null) {
    this.setAttachments(key, attachment ? [attachment] : []);
  }
  clearAttachment(key: string, options?: { revoke?: boolean }) {
    this.setAttachments(key, [], { revokeReplaced: options?.revoke });
  }
  clearAttachments(key: string, options?: { revoke?: boolean }) {
    this.clearAttachment(key, options);
  }
  withdraw(key: string, work: (requestId: string) => Promise<RecalledMessage[]>): Promise<void> {
    const request = this.requests.get(key) ?? { id: createUuid() };
    if (request.promise) return request.promise;
    this.requests.set(key, request);
    request.promise = Promise.resolve().then(() => work(request.id)).then(messages => {
      this.requests.delete(key);
      const current = this.recall(key);
      if (!messages.length) { this.update(key, { pending: false }); return; }
      const text = messages.map(message => message.text).filter(Boolean).join("\n\n");
      this.set(key, [this.get(key) ?? "", text].filter(Boolean).join("\n\n"));
      this.update(key, { revision: current.revision + 1, pending: false,
        images: [...current.images, ...messages.flatMap(message => message.images ?? [])] });
    }, error => {
      request.promise = undefined;
      this.update(key, { pending: false });
      throw error;
    });
    this.update(key, { pending: true });
    return request.promise;
  }
}
