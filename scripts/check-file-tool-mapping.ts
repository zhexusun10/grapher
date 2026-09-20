import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileToolMapping } from "./native-mapping/file-tool-operations.ts";
import { createReadToolDefinition } from "../pi/packages/coding-agent/src/core/tools/read.ts";
import { createWriteToolDefinition } from "../pi/packages/coding-agent/src/core/tools/write.ts";
import { createEditToolDefinition } from "../pi/packages/coding-agent/src/core/tools/edit.ts";
import { createBashToolDefinition } from "../pi/packages/coding-agent/src/core/tools/bash.ts";

const root = await realpath(await mkdtemp(join(tmpdir(), "grapher-file-mapping-")));
try {
  const source = join(root, "source");
  const a = join(root, "a"), b = join(root, "b"), sessions = join(root, "sessions");
  await Promise.all([source, a, b, sessions].map(path => mkdir(path)));
  await writeFile(join(source, "value"), "SOURCE");
  await writeFile(join(sessions, "private"), "SESSION");
  const external = join(root, "external");
  await writeFile(external, "EXTERNAL");
  const prefixPeer = `${source}-other`;
  await mkdir(prefixPeer);
  await writeFile(join(prefixPeer, "value"), "PREFIX-PEER");
  const maps = await Promise.all([
    fileToolMapping({ executionId: "A", project: source, workspace: a, blockedRoots: [b, sessions] }),
    fileToolMapping({ executionId: "B", project: source, workspace: b, blockedRoots: [a, sessions] }),
  ]);
  const text = (result: any) => result.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
  // All tool factories receive exactly the same project-visible cwd and same
  // tool inputs. Only the host-supplied operation binding differs.
  await Promise.all(maps.map(async mapping => {
    const tools = {
      read: createReadToolDefinition(source, { operations: mapping.read }),
      write: createWriteToolDefinition(source, { operations: mapping.write }),
      edit: createEditToolDefinition(source, { operations: mapping.edit }),
    };
    const id = mapping.executionId;
    await tools.write.execute(id, { path: join(source, "value"), content: id });
    assert.equal(text(await tools.read.execute(id, { path: "value" })), id);
    await tools.edit.execute(id, { path: join(source, "value"), edits: [{ oldText: id, newText: `${id}-EDIT` }] });
    assert.equal(text(await tools.read.execute(id, { path: join(source, "value") })), `${id}-EDIT`);
    await tools.write.execute(id, { path: join(source, "new", "nested.txt"), content: `literal source: ${source}` });
    assert.equal(await readFile(join(mapping.workspace, "new", "nested.txt"), "utf8"), `literal source: ${source}`, "never rewrite file content");
    await symlink(external, join(mapping.workspace, "external-link"));
    assert.equal(text(await tools.read.execute(id, { path: join(source, "external-link") })), "EXTERNAL");
    assert.equal(text(await tools.read.execute(id, { path: join(prefixPeer, "value") })), "PREFIX-PEER");
    const other = mapping.workspace === a ? b : a;
    for (const [name, target] of [["source-link", source], ["sibling-link", other], ["session-link", sessions]]) {
      await symlink(target, join(mapping.workspace, name));
      await assert.rejects(tools.write.execute(id, { path: join(source, name, "escape"), content: "escape" }), /rejected/);
      await assert.rejects(tools.read.execute(id, { path: join(source, name, name === "session-link" ? "private" : "value") }), /rejected/);
    }
    const abort = new AbortController(); abort.abort();
    await assert.rejects(tools.write.execute(id, { path: join(source, "cancelled"), content: "bad" }, abort.signal), /abort/i);
    await assert.rejects(access(join(mapping.workspace, "cancelled"), constants.F_OK));
    // Real bash runs in the private cwd, without rewriting its program. A
    // nested native Node constructs the absolute project path internally.
    const bash = createBashToolDefinition(mapping.workspace);
    const nested = "process.stdout.write(require('node:fs').readFileSync(require('node:path').join(process.argv[1],'value')))";
    const parent = `process.stdout.write(require('node:child_process').execFileSync(process.execPath, ['-e', ${JSON.stringify(nested)}, ${JSON.stringify(source)}]));`;
    // Shell quoting is deliberately only for the test argv, not path mapping.
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const result = await bash.execute(id, { command: `${quote(process.execPath)} -e ${quote(parent)}` });
    assert.equal(text(result).trim(), "SOURCE", "file operations mapping is not inherited by bash descendants");
  }));
  assert.equal(await readFile(join(a, "value"), "utf8"), "A-EDIT");
  assert.equal(await readFile(join(b, "value"), "utf8"), "B-EDIT");
  assert.equal(await readFile(join(source, "value"), "utf8"), "SOURCE");
  await assert.rejects(access(join(source, "escape"), constants.F_OK));
  await assert.rejects(access(join(sessions, "escape"), constants.F_OK));
  console.log(JSON.stringify({
    fileToolMappingPassed: true,
    tools: ["read", "write", "edit"],
    sameAbsolutePathWithSeparateActualFiles: true,
    sourceUnchanged: true,
    externalSymlinkPassed: true,
    sourceSiblingSessionSymlinksRejected: true,
    nestedBashChildReadsSource: true,
    arbitrarySubprocessMapping: false,
    productionLauncherTested: false,
    fullContractSatisfied: false,
    limits: ["No atomic protection against symlink swaps or hard links", "Pi normalizes paths before custom operations", "Source-pointing symlinks are rejected, not transparently redirected"],
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
