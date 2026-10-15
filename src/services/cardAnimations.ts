import { useEffect, useState } from "react";

/** Track committed presentations, not render attempts (which React may repeat). */
const presentedCardIds = new Set<string>();

/** Callers key cards by item ID. Keep the entrance for that entire mount so a
 * content/status/timestamp update cannot cancel its transform halfway through.
 * JSONL replay supplies explicit provenance; its parse-time timestamps do not
 * mean a completed historical card was just generated.
 */
export function useCardAppear(id: string | undefined, isLive: boolean, timestamp?: number, animateAppear?: boolean): boolean {
  const [animate] = useState(() => {
    if (id && presentedCardIds.has(id)) return false;
    if (animateAppear !== undefined) return animateAppear;
    return isLive || (typeof timestamp === "number" && Date.now() - timestamp < 4000);
  });
  useEffect(() => {
    if (id) presentedCardIds.add(id);
  }, [id]);
  return animate;
}

export function resetPresentedCardIds(): void {
  presentedCardIds.clear();
}
