import type { ImageAttachment } from "../types";

export interface RecalledMessage { text: string; images?: ImageAttachment[] }
interface RecallState { revision: number; images: ImageAttachment[]; pending: boolean }
const EMPTY: RecallState = { revision: 0, images: [], pending: false };

/** Run-owned drafts outlive individual composers. Typing stays uncontrolled;
 * only recalls/attachment changes notify subscribers. Failed recalls retain
 * their request identity so retrying cannot clear a newer queue. */
export class ComposerDrafts extends Map<string, string> {
  private recalls = new Map<string, RecallState>();
  private listeners = new Set<() => void>();
  private requests = new Map<string, { id: string; promise?: Promise<void> }>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  recall = (key: string): RecallState => this.recalls.get(key) ?? EMPTY;
  private update(key: string, patch: Partial<RecallState>) {
    this.recalls.set(key, { ...this.recall(key), ...patch });
    for (const listener of this.listeners) listener();
  }
  setImages(key: string, images: ImageAttachment[]) { this.update(key, { images }); }
  withdraw(key: string, work: (requestId: string) => Promise<RecalledMessage[]>): Promise<void> {
    const request = this.requests.get(key) ?? { id: crypto.randomUUID() };
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
