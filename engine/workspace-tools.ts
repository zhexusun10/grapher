import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  resolveToCwd,
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
  createLsToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  type ExtensionAPI,
} from './pi-compat.ts';

// Backend supplies the roots; tool input cannot choose an execution. This is an
// explicit file-tool adapter, not a process-wide namespace or security boundary.
export function workspacePathMapper(workspace: string, project: string, alias = project) {
  if (![workspace, project, alias].every(isAbsolute)) throw new Error('Execution roots must be absolute');
  const roots = [...new Set([resolve(project), resolve(alias)])].sort((a, b) => b.length - a.length);
  return (input: string) => {
    if (!input || input.includes('\0')) throw new Error('Invalid file path');
    const path = resolveToCwd(input, workspace);
    for (const root of roots) {
      const suffix = relative(root, path);
      if (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`)) return resolve(workspace, suffix);
    }
    return path;
  };
}

export function registerWorkspaceTools(pi: ExtensionAPI, workspace: string, project: string, alias = project, view: (value: any) => any = value => value) {
  const physical = workspacePathMapper(workspace, project, alias);
  for (const factory of [createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
    createLsToolDefinition, createFindToolDefinition, createGrepToolDefinition]) {
    const tool = factory(workspace);
    pi.registerTool({
      ...tool,
      async execute(id: string, params: any, signal?: AbortSignal, update?: any, ctx?: any) {
        if (signal?.aborted) throw new Error('Operation aborted');
        const mapped = { ...params, path: physical(params.path ?? '.') };
        // Mapping before native path resolution also covers grep/fd subprocesses
        // and Pi's own read existence/Unicode checks. Native results stay intact.
        try {
          return view(await (tool.execute as any)(id, mapped, signal,
            update ? (value: any) => update(view(value)) : undefined,
            ctx ? { ...ctx, cwd: workspace } : ctx));
        } catch (error) {
          if (error instanceof Error) error.message = view(error.message);
          throw error;
        }
      },
    } as any);
  }
}
