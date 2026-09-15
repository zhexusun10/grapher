export const sessions = new Map<string, {userId: string, expiresAt: number}>();
export function authenticate(token: string) { return sessions.get(token)?.userId; }
