import { isTauriDesktop } from "./apiBase";

type TauriInvoke = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

interface TauriRuntimeGlobal {
  __TAURI_INTERNALS__?: { invoke?: TauriInvoke };
  __TAURI__?: { core?: { invoke?: TauriInvoke } };
}

const OPEN_EXTERNAL_URL_COMMAND = "open_external_url";

function copyFallback(text: string): boolean {
  if (typeof document === "undefined") return false;
  const active = typeof HTMLElement !== "undefined" && document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  // Mount inside an active modal dialog so useDialogFocus's focusin containment
  // does not pull focus away and clear the selection before execCommand("copy").
  const container = active?.closest?.('[role="dialog"], [role="alertdialog"]') ?? document.body;
  if (!container) return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.tabIndex = -1;
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  container.appendChild(textarea);
  let copied = false;
  try {
    textarea.select();
    textarea.setSelectionRange?.(0, text.length);
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    textarea.remove();
    if (active?.isConnected) {
      try { active.focus({ preventScroll: true }); } catch {}
    }
  }
  return copied;
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // WebView2 and older desktop WebViews may not expose the async clipboard API.
  }
  return copyFallback(text);
}

function getTauriInvoke(): TauriInvoke | null {
  if (typeof globalThis === "undefined") return null;
  const host = globalThis as unknown as TauriRuntimeGlobal;
  if (typeof host.__TAURI_INTERNALS__?.invoke === "function") {
    return host.__TAURI_INTERNALS__.invoke.bind(host.__TAURI_INTERNALS__);
  }
  if (typeof host.__TAURI__?.core?.invoke === "function") {
    return host.__TAURI__.core.invoke.bind(host.__TAURI__.core);
  }
  return null;
}

export function resolveExternalHttpUrl(rawHref: string, baseHref?: string): string | null {
  const trimmed = rawHref.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  try {
    const parsed = baseHref ? new URL(trimmed, baseHref) : new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password || !parsed.hostname) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export async function openExternalUrl(rawUrl: string): Promise<boolean> {
  const safeUrl = resolveExternalHttpUrl(rawUrl);
  if (!safeUrl) return false;
  if (isTauriDesktop()) {
    const invoke = getTauriInvoke();
    if (invoke) {
      try {
        await invoke(OPEN_EXTERNAL_URL_COMMAND, { url: safeUrl });
        return true;
      } catch {
        return false;
      }
    }
  }
  try {
    if (typeof window !== "undefined" && typeof window.open === "function") {
      window.open(safeUrl, "_blank", "noopener,noreferrer");
      return true;
    }
  } catch {
    // Popup blocked or unavailable; callers keep a visible link when needed.
  }
  return false;
}

function findAnchorElement(target: EventTarget | null): HTMLAnchorElement | null {
  if (!target) return null;
  if (typeof Element !== "undefined" && target instanceof Element) {
    return target.closest<HTMLAnchorElement>("a[href]");
  }
  const parent = (target as { parentElement?: Element | null }).parentElement;
  return parent?.closest<HTMLAnchorElement>("a[href]") ?? null;
}

/**
 * Intercepts external HTTP(S) anchor clicks inside the Tauri desktop WebView and
 * delegates them to the native `open_external_url` IPC command so `target="_blank"`
 * links open in the user's system browser. Browser mode is left untouched.
 */
export function installDesktopExternalLinkHandler(
  targetDocument: Document | null = typeof document !== "undefined" ? document : null,
): () => void {
  if (!targetDocument || !isTauriDesktop()) return () => {};
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = findAnchorElement(event.target);
    if (!anchor || anchor.hasAttribute("download")) return;
    const rawHref = anchor.getAttribute("href");
    if (!rawHref) return;
    const baseHref = targetDocument.location?.href;
    const resolved = resolveExternalHttpUrl(rawHref, baseHref);
    if (!resolved) return;
    const targetAttr = (anchor.getAttribute("target") ?? anchor.target ?? "").trim().toLowerCase();
    const currentOrigin = targetDocument.location?.origin;
    // Custom schemes like `tauri://localhost` can expose an opaque `"null"`
    // origin in WebKit; any validated HTTP(S) URL is external in that case.
    const isDifferentOrigin = !currentOrigin || currentOrigin === "null" || new URL(resolved).origin !== currentOrigin;
    const isExternalTarget = targetAttr === "_blank" || isDifferentOrigin;
    if (!isExternalTarget) return;
    event.preventDefault();
    void openExternalUrl(resolved);
  };
  targetDocument.addEventListener("click", onClick);
  return () => targetDocument.removeEventListener("click", onClick);
}
