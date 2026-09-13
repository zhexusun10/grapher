// Transform only the upstream-owned default preamble. Never rewrite user
// prompts, project context, tool instructions, skills, or provider/auth code.
const identity = "You are an expert coding assistant operating inside pi, a coding agent harness.";
const docsStart = "\n\nPi documentation (";
const docsEnd = "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)";

export function grapherSystemPrompt(prompt) {
  if (!prompt.startsWith(identity)) return prompt; // Explicit planner/user override.
  const start = prompt.indexOf(docsStart);
  const end = prompt.indexOf(docsEnd, start);
  if (start < 0 || end < start) throw new Error("Upstream system prompt contract changed; review the Grapher prompt adapter.");
  return (prompt.slice(0, start) + prompt.slice(end + docsEnd.length))
    .replace(identity, "You are an expert coding assistant executing an Execution Instance in Grapher.");
}
