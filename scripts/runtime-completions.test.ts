import assert from "node:assert/strict";
import test from "node:test";
import { runtimeService } from "../src/services/runtime.ts";
import { hasCurrentPlanningRun } from "../src/services/planningRecovery.ts";
import { emptySnapshot, defaultConfig, type Snapshot } from "../src/types.ts";

const response = (result: unknown) => new Response(JSON.stringify({ result }), {
  headers: { "Content-Type": "application/json" },
});

test("an empty skill refresh removes cached skills rather than resurrecting them", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  const repository = "/test/removed-skills";
  try {
    globalThis.fetch = async () => response({ skills: ++calls === 1 ? [{ name: "removed", description: "", path: "/old", scope: "workspace" }] : [] });
    assert.equal((await runtimeService.listSkills(repository, true)).length, 1);
    assert.deepEqual(await runtimeService.listSkills(repository, true), []);
    assert.deepEqual(await runtimeService.listSkills(repository), []);
    assert.equal(calls, 2, "the authoritative empty result is cached");
  } finally { globalThis.fetch = original; }
});

for (const type of ["files", "skills"] as const) {
  test(`an older ${type} request cannot overwrite a newer refresh in the shared cache`, async () => {
    const original = globalThis.fetch;
    let release!: (value: Response) => void;
    let requests = 0;
    const repository = `/test/ordered-${type}`;
    const old = type === "files" ? ["old.ts"] : [{ name: "old", description: "", path: "/old", scope: "workspace" }];
    const current = type === "files" ? ["new.ts"] : [{ name: "new", description: "", path: "/new", scope: "workspace" }];
    const load = type === "files" ? runtimeService.listFiles : runtimeService.listSkills;
    try {
      globalThis.fetch = async () => ++requests === 1
        ? new Promise<Response>(resolve => { release = resolve; })
        : response({ [type]: current });
      const pending = load(repository, true);
      assert.deepEqual(await load(repository, true), current);
      release(response({ [type]: old }));
      await pending;
      assert.deepEqual(await load(repository), current);
      assert.equal(requests, 2);
    } finally { globalThis.fetch = original; }
  });
}

test("aborted requests retain their cancellation error instead of reporting a backend outage", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  const cancellation = new DOMException("Cancelled", "AbortError");
  controller.abort(cancellation);
  try {
    globalThis.fetch = async () => { throw cancellation; };
    await assert.rejects(runtimeService.snapshot(controller.signal), error => error === cancellation);
  } finally { globalThis.fetch = original; }
});

test("legacy completion is normalized across snapshot APIs without changing other statuses or content", async () => {
  const original = globalThis.fetch;
  const statuses = ["done", "completed", "waiting", "running", "paused", "blocked", "failed", "dirty"];
  const wire = { ...emptySnapshot, runId: "legacy-label", phase: "publication_failed",
    graph: { originalGoal: "Keep done in user content", nodes: statuses.map(name => ({ name, task: name })), edges: [] },
    nodes: Object.fromEntries(statuses.map(status => [status, { status, revision: 1, head: "retained", instruction: "done is literal user text", error: null }])),
    extra: { evidence: "untouched" } };
  const expected = structuredClone(wire);
  expected.nodes.done.status = "completed";
  try {
    globalThis.fetch = async url => {
      const command = String(url).split("/").at(-1);
      return response(command === "bootstrap" || command === "save_config"
        ? { config: defaultConfig, snapshot: wire, runs: [wire.runId], dataPath: "/mock" }
        : command === "snapshot_if_changed" ? { version: "legacy-v1", snapshot: wire } : wire);
    };
    const reads = [
      () => runtimeService.snapshot(),
      () => runtimeService.snapshotForRun(wire.runId),
      () => runtimeService.history(wire.runId),
      () => runtimeService.loadRun(wire.runId),
      () => runtimeService.getPlanningSnapshot("planning", "/mock"),
      () => runtimeService.control("pause"),
      () => runtimeService.saveGraph(wire.graph, defaultConfig),
      () => runtimeService.planGoal("goal", defaultConfig),
      () => runtimeService.editPlanner({ runId: wire.runId, oldText: "old", instruction: "new" }),
      () => runtimeService.editNode({ runId: wire.runId, node: "done", executionId: "exec", oldText: "old", instruction: "new" }),
    ];
    for (const read of reads) assert.deepEqual(await read(), expected);
    assert.deepEqual((await runtimeService.bootstrap()).snapshot, expected);
    assert.deepEqual((await runtimeService.saveConfig(defaultConfig)).snapshot, expected);
    const poll = await runtimeService.snapshotIfChanged(null, undefined, wire.runId);
    assert.equal(poll.version, "legacy-v1");
    assert.deepEqual(poll.snapshot, expected);
    globalThis.fetch = async () => response({ version: "legacy-v1", snapshot: null });
    assert.equal((await runtimeService.snapshotIfChanged("legacy-v1")).snapshot, null);
    assert.equal(wire.nodes.done.status, "done", "the wire fixture is not rewritten");
  } finally { globalThis.fetch = original; }
});

test("current snapshots retain their identities and normalization never mutates legacy snapshots", async () => {
  const original = globalThis.fetch;
  const node = Object.freeze({ status: "completed" as const, revision: 1, head: "head", instruction: "", error: null });
  const current = Object.freeze({ ...emptySnapshot, runId: "current-label", nodes: Object.freeze({ task: node }) });
  const legacyNode = Object.freeze({ ...node, status: "done" });
  const legacy = Object.freeze({ ...current, nodes: Object.freeze({ task: legacyNode, unchanged: node }) });
  let wire: unknown = current;
  try {
    globalThis.fetch = async () => {
      const result = response(null);
      result.json = async () => ({ result: wire });
      return result;
    };
    assert.equal(await runtimeService.snapshot(), current);
    wire = legacy;
    const normalized = await runtimeService.snapshot();
    assert.equal(normalized.nodes.task.status, "completed");
    assert.equal(legacy.nodes.task.status, "done");
    assert.equal(normalized.nodes.unchanged, node);
    assert.equal(normalized.graph, legacy.graph);
    assert.equal(normalized.events, legacy.events);
  } finally { globalThis.fetch = original; }
});

test("Planner completion streams normalize legacy node status before notifying the UI", async () => {
  const original = globalThis.fetch;
  const wire = { ...emptySnapshot, runId: "stream-label", phase: "needs_attention",
    nodes: { task: { status: "done", revision: 1, head: "head", instruction: "", error: null } } };
  try {
    for (const wrapped of [false, true]) {
      let notified: Snapshot | undefined;
      globalThis.fetch = async () => new Response(
        `event: complete\ndata: ${JSON.stringify(wrapped ? { snapshot: wire } : wire)}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
      const result = await runtimeService.planGoalStream("goal", defaultConfig, event => {
        if (event.type === "complete") notified = event.snapshot;
      });
      assert.equal(result.nodes.task.status, "completed");
      assert.equal(result.phase, "needs_attention", "renaming a node status cannot mark the Run completed");
      assert.equal(notified, result);
    }
  } finally { globalThis.fetch = original; }
});

test("a durable planning or failed planning Run stays attached to its workspace", () => {
  for (const phase of ["planning", "planning_failed", "paused", "needs_attention", "awaiting_approval", "running"]) {
    const snapshot = { runId: "saved-run", phase, config: { repository: "/project" } } as Snapshot;
    assert.equal(hasCurrentPlanningRun(snapshot, "/project"), true);
    assert.equal(hasCurrentPlanningRun(snapshot, "/other-project"), false);
    assert.equal(hasCurrentPlanningRun({ ...snapshot, runId: "" }, "/project"), false);
  }
  // Windows path aliases, slash differences, and casing resolve to the same workspace
  const windowsSnapshot = { runId: "win-run", phase: "paused", config: { repository: "C:\\Users\\repo" } } as Snapshot;
  assert.equal(hasCurrentPlanningRun(windowsSnapshot, "c:/users/repo"), true);
  assert.equal(hasCurrentPlanningRun(windowsSnapshot, "C:/Users/repo/"), true);
  assert.equal(hasCurrentPlanningRun(windowsSnapshot, "C:\\Users\\other"), false);
});

test("a terminal Planner revision completes without waiting for SSE EOF", { timeout: 2000 }, async () => {
  const original = globalThis.fetch;
  const snapshot = { runId: "revision-run", phase: "awaiting_approval", approved: false } as Snapshot;
  let cancelled = false;
  const events: string[] = [];
  try {
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        const wire = `event: complete\ndata: ${JSON.stringify({ snapshot })}\n\n`;
        // The terminal frame can span transport packets, without closing HTTP.
        const bytes = new TextEncoder().encode(wire);
        controller.enqueue(bytes.slice(0, 20));
        controller.enqueue(bytes.slice(20));
      },
      cancel() { cancelled = true; },
    }), { headers: { "Content-Type": "text/event-stream" } });
    const result = await runtimeService.planGoalStream("Append a planning instruction", {} as import("../src/types.ts").Config,
      event => events.push(event.type), "graph", undefined, undefined, snapshot.runId);
    assert.deepEqual(result, snapshot);
    assert.deepEqual(events, ["complete"]);
    assert.equal(cancelled, true, "release a terminal stream rather than leaking an open reader");
  } finally { globalThis.fetch = original; }
});

test("planning stream preserves the persisted Run identity through completion", async () => {
  const original = globalThis.fetch;
  const snapshot = { runId: "saved-run", phase: "awaiting_approval" } as Snapshot;
  const events: string[] = [];
  try {
    globalThis.fetch = async () => new Response(
      `event: run_started\ndata: {"runId":"saved-run"}\n\nevent: complete\ndata: ${JSON.stringify({ snapshot })}\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    );
    const result = await runtimeService.planGoalStream("Goal", {} as import("../src/types.ts").Config,
      event => { if (event.type === "run_started") events.push(event.runId!); });
    assert.deepEqual(events, [result.runId]);
  } finally { globalThis.fetch = original; }
});
