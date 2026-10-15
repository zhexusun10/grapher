/**
 * Track card presentations so only newly mounted live cards play the entrance animation,
 * preventing historical cards or virtualized rows from repeatedly re-triggering appear
 * animations when scrolling through the transcript.
 */
const presentedCardIds = new Set<string>();

export function shouldCardAnimateAppear(id: string | undefined, isLive: boolean, timestamp?: number): boolean {
  if (!id) return isLive;
  if (presentedCardIds.has(id)) return false;
  presentedCardIds.add(id);
  // Animate if live/running or created within the last 4 seconds
  return isLive || (typeof timestamp === "number" && Date.now() - timestamp < 4000);
}

export function resetPresentedCardIds(): void {
  presentedCardIds.clear();
}
