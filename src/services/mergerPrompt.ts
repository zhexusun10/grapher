export const MERGER_GIT_INSTRUCTIONS =
  "Resolve the current Git merge conflicts. Preserve valid changes. Do not modify unrelated files. Stage the resolved files and verify that no unresolved conflicts remain. Do not discard the incoming commit.\nProject snapshots include project files ignored by .gitignore. Stage resolved or changed project paths with git add -f -- <paths>, even when they match .gitignore. Do not stage Git/Grapher internals or managed environment/cache scopes.";

// Production node/publication Mergers run against an independent project view;
// graph Git stays host-only, so the visible repository never carries MERGE_HEAD.
export const PROJECT_MERGER_INSTRUCTIONS =
  "Resolve the conflicting project files in this workspace. Preserve valid changes and do not modify unrelated files. The project Git view matches the source; internal composition commits are not part of it. If .git is present, stage each resolved path with git add -f -- <paths> and verify there are no unmerged index entries. Do not invent a merge or snapshot commit. If the source has no .git, resolve the files directly without initializing Git. The backend records the resolved project files and preserves the composition parents.";

export function getMergerSystemPrompt(queryOrTask?: string): string {
  const query = (queryOrTask || "").trim();
  return `The Workspace Objective below is ONLY to help you decide how conflicting changes should be integrated.
Do NOT attempt to execute or fulfill this task in this session. Your sole responsibility is Git conflict repair using the available file and Bash tools.

Workspace Objective:
<workspace_objective>
${query}
</workspace_objective>

${PROJECT_MERGER_INSTRUCTIONS}`;
}

