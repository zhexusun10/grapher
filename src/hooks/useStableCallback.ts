import { useCallback, useLayoutEffect, useRef } from "react";

/** Stable prop identity, with the same closure as the latest committed render. */
export function useStableCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result) {
  const latest = useRef(callback);
  useLayoutEffect(() => { latest.current = callback; });
  return useCallback((...args: Args) => latest.current(...args), []);
}
