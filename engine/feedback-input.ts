// Private turn identity is durable in Pi, but is never part of model context.
// Pi can append image normalization hints after the envelope, so it need not be
// the last line. Only a complete reserved UUID line is removed.
const marker = /\n\n<grapher-feedback-id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}<\/grapher-feedback-id>(?=\n|$)/g;

export function feedbackInputContext<T extends { role: string; content?: unknown }>(messages: T[]): T[] {
  return messages.map(message => {
    if (message.role !== 'user') return message;
    if (typeof message.content === 'string') {
      const content = message.content.replace(marker, '');
      return content === message.content ? message : { ...message, content };
    }
    if (!Array.isArray(message.content)) return message;
    let changed = false;
    const content = message.content.map((part: any) => {
      if (part?.type !== 'text' || typeof part.text !== 'string') return part;
      const text = part.text.replace(marker, '');
      if (text === part.text) return part;
      changed = true;
      return { ...part, text };
    });
    return changed ? { ...message, content } : message;
  });
}
