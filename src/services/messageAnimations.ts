import { useEffect, useState } from "react";

/** User turns animate once per id. Unlike card provenance, the set survives
 * conversation switches so reopening history never replays a sent message. */
const presentedUserTurnIds = new Set<string>();

export function useUserTurnAppear(id: string | undefined, animateAppear?: boolean): boolean {
  const [animate] = useState(() => Boolean(animateAppear) && !!id && !presentedUserTurnIds.has(id));
  useEffect(() => {
    if (id) presentedUserTurnIds.add(id);
  }, [id]);
  return animate;
}
