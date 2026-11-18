import { isAbsolute, resolve } from 'node:path';
import {
  isCaseInsensitive,
  mapPhysicalPath,
  msysHostInput,
  resolveSourceCaseInsensitive,
  toHostInput,
} from './path-identity.mjs';
import {
  resolveToCwd,
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
  type ExtensionAPI,
} from './pi-compat.ts';

export type CaseSensitivityOptions = {
  workspaceCaseInsensitive?: boolean;
  sourceCaseInsensitive?: boolean;
};

// Backend supplies the roots; tool input cannot choose an execution. This is an
// explicit file-tool adapter, not a process-wide namespace or security boundary.
export function workspacePathMapper(
  workspace: string,
  project: string,
  alias = project,
  options: CaseSensitivityOptions = {},
) {
  // Normalize extended/MSYS spellings once; tool input and roots then share the
  // same host-form comparison space.
  const hostWorkspace = toHostInput(workspace);
  const hostProject = toHostInput(project);
  const hostAlias = toHostInput(alias);
  if (![hostWorkspace, hostProject, hostAlias].every(isAbsolute)) throw new Error('Execution roots must be absolute');
  const roots = [...new Set([resolve(hostProject), resolve(hostAlias)])].sort((a, b) => b.length - a.length);
  const mappedWorkspace = resolve(hostWorkspace);
  const workspaceCaseInsensitive = options.workspaceCaseInsensitive ?? isCaseInsensitive(mappedWorkspace);
  const sourceCaseInsensitive = resolveSourceCaseInsensitive(workspaceCaseInsensitive, options.sourceCaseInsensitive);
  return (input: string) => {
    if (!input || input.includes('\0')) throw new Error('Invalid file path');
    // Accept file URLs, /c/... and registered Git Bash mounts such as /tmp
    // before Pi resolves the value against the workspace.
    const path = resolveToCwd(toHostInput(msysHostInput(input)), mappedWorkspace);
    return mapPhysicalPath(path, mappedWorkspace, roots, workspaceCaseInsensitive, sourceCaseInsensitive);
  };
}

export function registerWorkspaceTools(
  pi: ExtensionAPI,
  workspace: string,
  project: string,
  alias = project,
  view: (value: any) => any = value => value,
  names?: readonly string[],
  workspaceGetter: () => string = () => workspace,
  options: CaseSensitivityOptions = {},
) {
  const physical = (input: string) => workspacePathMapper(workspaceGetter(), project, alias, options)(input);
  // ls/find/grep are deliberately absent for every project and role: search and
  // listing go through Bash, so the model-facing tool surface stays read/write/edit.
  for (const factory of [createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition]) {
    const tool = factory(workspace);
    if (names && !names.includes(tool.name)) continue;
    pi.registerTool({
      ...tool,
      async execute(id: string, params: any, signal?: AbortSignal, update?: any, ctx?: any) {
        if (signal?.aborted) throw new Error('Operation aborted');
        const currentWorkspace = workspaceGetter();
        const mapped = { ...params, path: physical(params.path ?? '.') };
        // Mapping before native path resolution also covers Pi's own read
        // existence/Unicode checks. Native results stay intact.
        try {
          return view(await (tool.execute as any)(id, mapped, signal,
            update ? (value: any) => update(view(value)) : undefined,
            ctx ? { ...ctx, cwd: currentWorkspace } : ctx));
        } catch (error) {
          if (error instanceof Error) error.message = view(error.message);
          throw error;
        }
      },
    } as any);
  }
}
