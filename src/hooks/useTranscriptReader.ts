import { useEffect, useRef } from "react";
import { registerTranscriptReader } from "../services/transcriptCache";

/** One lifetime per mounted history; individual polls can additionally be cancelled. */
export function useTranscriptReader(kind: "execution" | "planning", key: string) {
  const signal = useRef<AbortSignal | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    signal.current = controller.signal;
    return registerTranscriptReader(kind, key, controller);
  }, [kind, key]);
  return signal;
}
