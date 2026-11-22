type ResizeCallback = (entry: ResizeObserverEntry) => void;

let listeners = new WeakMap<Element, Set<ResizeCallback>>();
let sharedObserver: ResizeObserver | null = null;
let sharedObserverCtor: typeof ResizeObserver | null = null;

function getObserver(): { observer: ResizeObserver; map: WeakMap<Element, Set<ResizeCallback>> } | null {
  if (typeof ResizeObserver === "undefined") return null;
  if (!sharedObserver || sharedObserverCtor !== ResizeObserver) {
    sharedObserverCtor = ResizeObserver;
    const map = new WeakMap<Element, Set<ResizeCallback>>();
    listeners = map;
    sharedObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const callbacks = map.get(entry.target);
        if (!callbacks || callbacks.size === 0) continue;
        if (callbacks.size === 1) {
          for (const callback of callbacks) callback(entry);
        } else {
          for (const callback of [...callbacks]) callback(entry);
        }
      }
    });
  }
  return { observer: sharedObserver, map: listeners };
}

/** Share a single native ResizeObserver across all virtualized rows and cards
 * instead of allocating one observer per mounted DOM element. */
export function observeElementResize(element: Element, callback: ResizeCallback): () => void {
  const active = getObserver();
  if (!active) return () => {};
  const { observer, map } = active;
  let callbacks = map.get(element);
  if (!callbacks) {
    callbacks = new Set();
    map.set(element, callbacks);
    observer.observe(element);
  }
  callbacks.add(callback);
  return () => {
    const current = map.get(element);
    if (!current) return;
    current.delete(callback);
    if (current.size === 0) {
      map.delete(element);
      observer.unobserve(element);
    }
  };
}
