// File-tool mapping experiment only. Not imported by the production launcher.
// Uses Pi's existing operations seam; does not rewrite commands, contents or
// results, monkey-patch fs, or claim to control arbitrary subprocesses.
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ReadOperations } from "../../pi/packages/coding-agent/src/core/tools/read.ts";
import type { WriteOperations } from "../../pi/packages/coding-agent/src/core/tools/write.ts";
import type { EditOperations } from "../../pi/packages/coding-agent/src/core/tools/edit.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../pi/packages/coding-agent/src/utils/mime.ts";

function inside(root: string, path: string) {
  const suffix = relative(root, path);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}

export async function fileToolMapping(binding: {
  executionId: string;
  project: string;
  workspace: string;
  blockedRoots: string[];
}) {
  if (!binding.executionId || !isAbsolute(binding.project) || !isAbsolute(binding.workspace)
    || binding.blockedRoots.some(path => !isAbsolute(path))) {
    throw new Error("Host binding requires execution identity and absolute roots");
  }
  const project = await realpath(binding.project);
  const workspace = await realpath(binding.workspace);
  if (inside(project, workspace) || inside(workspace, project)) {
    throw new Error("This Graph probe requires non-overlapping source and workspace");
  }
  const blocked = [project, ...await Promise.all(binding.blockedRoots.map(path => realpath(path)))];
  if (blocked.some(path => inside(path, workspace))) throw new Error("Workspace is blocked");
  // Capture immutable host binding values. Tool inputs cannot choose execution.
  const sourceAlias = resolve(binding.project);
  async function physical(input: string): Promise<string> {
    if (!input || input.includes("\0")) throw new Error("Invalid file path");
    // Dot segments across symlinks need a full filesystem resolver. Reject in
    // this prototype rather than pretending lexical normalization is equivalent.
    if (input.split(sep).includes("..")) throw new Error("Parent traversal is not supported by this probe");
    const requested = isAbsolute(input) ? resolve(input) : resolve(project, input);
    const logicalRoot = inside(sourceAlias, requested) ? sourceAlias : project;
    const target = inside(logicalRoot, requested)
      ? join(workspace, relative(logicalRoot, requested)) : requested;
    // Find a real existing ancestor for new files. Broken links fail explicitly.
    let cursor = target;
    const missing: string[] = [];
    for (;;) {
      try { await lstat(cursor); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(cursor) === cursor) throw error;
        missing.unshift(relative(dirname(cursor), cursor));
        cursor = dirname(cursor);
      }
    }
    const canonical = join(await realpath(cursor), ...missing);
    if (blocked.some(root => inside(root, canonical))) {
      throw new Error("File-tool mapping rejected a source/sibling/session alias");
    }
    return canonical;
  }
  const read: ReadOperations = {
    readFile: async path => readFile(await physical(path)),
    access: async path => access(await physical(path), constants.R_OK),
    detectImageMimeType: async path => detectSupportedImageMimeTypeFromFile(await physical(path)),
  };
  const write: WriteOperations = {
    writeFile: async (path, content) => { await writeFile(await physical(path), content, "utf8"); },
    mkdir: async path => { await mkdir(await physical(path), { recursive: true }); },
  };
  const edit: EditOperations = {
    readFile: read.readFile,
    writeFile: write.writeFile,
    access: async path => access(await physical(path), constants.R_OK | constants.W_OK),
  };
  // The checks above are NOT atomic with filesystem operations (TOCTOU), and
  // do not detect hard links or constrain processes. They are not a sandbox.
  return Object.freeze({ executionId: binding.executionId, project, workspace, read, write, edit, physical });
}
