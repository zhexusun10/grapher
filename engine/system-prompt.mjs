// Remove Pi-specific self-identification and documentation routing from the
// upstream default prompt while leaving the rest of the coding-agent prompt intact.
const PI_IDENTITY = 'You are an expert coding assistant operating inside pi, a coding agent harness.';

export function grapherSystemPrompt(prompt) {
  return prompt
    .replace(PI_IDENTITY, 'You are an expert coding assistant.')
    .replace(/\n<docs>[\s\S]*?<\/docs>/, '');
}
