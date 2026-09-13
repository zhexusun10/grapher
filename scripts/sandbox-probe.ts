// Executed inside the real macOS sandbox by backend/tests/sandbox.rs.
// No live provider requests or real credentials are used.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createBashTool, createReadTool, createWriteTool, createEditTool, ModelRuntime } from "../pi/packages/coding-agent/src/index.ts";

const [source, sibling, outside] = process.argv.slice(2);
const cwd = process.cwd();
const read = createReadTool(cwd);
const write = createWriteTool(cwd);
const edit = createEditTool(cwd);
const bash = createBashTool(cwd);
await write.execute("write", { path: "tool-file", content: "before" });
await edit.execute("edit", { path: "tool-file", edits: [{ oldText: "before", newText: "after" }] });
assert.equal(readFileSync(join(cwd, "tool-file"), "utf8"), "after");
assert.match(JSON.stringify(await read.execute("read", { path: "tool-file" })), /after/);
await write.execute("write-outside", { path: join(outside, "tool-file"), content: "outside" });
for (const blocked of [source, sibling]) {
  await assert.rejects(() => read.execute("read-blocked", { path: join(blocked, "marker") }));
  await assert.rejects(() => write.execute("write-blocked", { path: join(blocked, "marker"), content: "wrong" }));
  await assert.rejects(() => edit.execute("edit-blocked", { path: join(blocked, "marker"), edits: [{ oldText: "original", newText: "wrong" }] }));
  const quoted = `'${join(blocked, "marker").replaceAll("'", "'\\''")}'`;
  await assert.rejects(() => bash.execute("bash-blocked", { command: `/bin/cat ${quoted}` }));
}
// A fake credential file in an isolated PI_CODING_AGENT_DIR proves that the
// upstream credential reader still works. No key is transmitted or printed.
const models = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
assert.equal((await models.checkAuth("openai"))?.type, "api_key");
assert.ok(models.getProviders().length > 0);
console.log("Upstream read/write/edit/bash and provider/auth sandbox probe passed");
