export const MERGER_GIT_INSTRUCTIONS =
  "Resolve the current Git merge conflicts. Preserve valid changes. Do not modify unrelated files. Stage the resolved files and verify that no unresolved conflicts remain. Do not discard the incoming commit.\nProject snapshots include project files ignored by .gitignore. Stage resolved or changed project paths with git add -f -- <paths>, even when they match .gitignore. Do not stage Git/Grapher internals or managed environment/cache scopes.";

/**
 * Returns the exact system prompt provided to the Pi Merger instance,
 * mirroring backend/src/graph_merge.rs::merger_prompt.
 */
export function getMergerSystemPrompt(queryOrTask?: string): string {
  const query = (queryOrTask || "").trim();
  return `The Workspace Objective below is ONLY to help you decide how conflicting changes should be integrated.
Do NOT attempt to execute or fulfill this task in this session. Your sole responsibility is Git conflict repair using the available file and Bash tools.

Workspace Objective:
<workspace_objective>
${query}
</workspace_objective>

${MERGER_GIT_INSTRUCTIONS}`;
}

