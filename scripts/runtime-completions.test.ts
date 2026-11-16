import assert from "node:assert/strict";
import test from "node:test";
import { RunNotFoundError, runtimeService } from "../src/services/runtime.ts";
import { executionTranscriptCache } from "../src/services/transcriptCache.ts";
import { hasCurrentPlanningRun } from "../src/services/planningRecovery.ts";
import { emptySnapshot, defaultConfig, type Snapshot } from "../src/types.ts";

const response = (result: unknown) => new Response(JSON.stringify({ result }), {
  headers: { "Content-Type": "application/json" },
});

test("Run load failures stop at the authoritative endpoint and validate response ownership", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  try {
    for (const error of ["Unsupported Grapher database format", "Run not found", "Cannot load Run"]) {
      calls.length = 0;
      globalThis.fetch = async url => {
        calls.push(String(url));
        return new Response(JSON.stringify({ error }), { status: 400 });
      };
      await assert.rejects(runtimeService.loadRun("requested"));
      assert.deepEqual(calls, ["/api/load_run"], "a failed load cannot be bypassed by snapshot/history");
    }
    globalThis.fetch = async () => response({ ...emptySnapshot, runId: "other" });
    await assert.rejects(runtimeService.loadRun("requested"), /不匹配|match/i);
  } finally { globalThis.fetch = original; }
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

for (const operation of ["upload", "delete"] as const) {
  test(`attachment ${operation} invalidates file-list reads already in flight`, async () => {
    const originalFetch = globalThis.fetch;
    const originalReader = globalThis.FileReader;
    const repository = `/test/attachment-${operation}-file-list`;
    const path = "grapher-attachments/00000000-0000-4000-8000-000000000009/input.txt";
    let release!: (value: Response) => void;
    let reads = 0;
    const current = operation === "upload" ? [path] : [];
    try {
      globalThis.FileReader = class {
        result = "data:text/plain;base64,Zml4dHVyZQ==";
        onload: (() => void) | null = null;
        readAsDataURL() { queueMicrotask(() => this.onload?.()); }
      } as unknown as typeof FileReader;
      globalThis.fetch = async url => String(url).endsWith("list_files")
        ? ++reads === 1 ? new Promise<Response>(resolve => { release = resolve; }) : response({ files: current })
        : response({ name: "input.txt", path, success: true });
      const old = runtimeService.listFiles(repository, true);
      if (operation === "upload") await runtimeService.writeWorkspaceFile(new File(["fixture"], "input.txt"), repository);
      else await runtimeService.deleteWorkspaceFile(path, repository);
      release(response({ files: operation === "upload" ? [] : [path] }));
      await old;
      assert.deepEqual(await runtimeService.listFiles(repository), current);
      assert.equal(reads, 2, "a pre-mutation read cannot repopulate the invalidated cache");
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.FileReader = originalReader;
    }
  });
}

for (const type of ["files", "skills"] as const) {
  test(`failed ${type} reads remain retryable without caching an empty result or erasing a valid cache`, async () => {
    const original = globalThis.fetch;
    const repository = `/test/retry-${type}`;
    const load = type === "files" ? runtimeService.listFiles : runtimeService.listSkills;
    const current = type === "files" ? ["recovered.ts"] : [{ name: "recovered", description: "Available again", path: "/skill", scope: "workspace" }];
    let fail = true, calls = 0;
    try {
      globalThis.fetch = async () => {
        calls++;
        return fail ? new Response(JSON.stringify({ error: "Temporary outage" }), { status: 503 }) : response({ [type]: current });
      };
      await assert.rejects(load(repository), /Temporary outage/);
      fail = false;
      assert.deepEqual(await load(repository), current);
      fail = true;
      await assert.rejects(load(repository, true), /Temporary outage/);
      assert.deepEqual(await load(repository), current, "a failed refresh does not replace the previous authoritative cache");
      assert.equal(calls, 3);
    } finally { globalThis.fetch = original; }
  });
}

test("attachment requests preserve Run targeting and reject missing, legacy or traversing response paths", async () => {
  const originalFetch = globalThis.fetch;
  const originalReader = globalThis.FileReader;
  const id = "00000000-0000-4000-8000-000000000004";
  const path = `grapher-attachments/${id}/中文说明.txt`;
  const file = new File(["fixture"], "中文说明.txt", { type: "text/plain" });
  let result: unknown = { name: file.name, path };
  let sent: Record<string, unknown> | undefined;
  const commands: string[] = [];
  try {
    globalThis.FileReader = class {
      result = "data:text/plain;base64,Zml4dHVyZQ==";
      onload: (() => void) | null = null;
      readAsDataURL() { queueMicrotask(() => this.onload?.()); }
    } as unknown as typeof FileReader;
    globalThis.fetch = async (url, init) => {
      commands.push(String(url));
      sent = JSON.parse(String(init?.body));
      return response(result);
    };
    assert.deepEqual(await runtimeService.writeWorkspaceFile(file, "/repo", {
      runId: "owning-run", node: "merge:worker", attachmentId: id,
    }), result);
    assert.equal(sent?.runId, "owning-run");
    assert.equal(sent?.node, "merge:worker");
    assert.equal(sent?.attachmentId, id);
    assert.equal(commands.at(-1), "/api/write_workspace_attachment");
    await runtimeService.writeWorkspaceFile(file, "/repo", { runId: "", node: "" });
    assert.equal(Object.hasOwn(sent!, "runId"), false, "a failed/empty conversation uploads as a new source input");
    assert.equal(Object.hasOwn(sent!, "node"), false);
    for (const invalid of [undefined, file.name, `grapher-attachments/${id}/../../original.txt`]) {
      result = { name: file.name, path: invalid };
      await assert.rejects(runtimeService.writeWorkspaceFile(file, "/repo"));
    }
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "Cannot delete attachment" }), { status: 400 });
    await assert.rejects(runtimeService.deleteWorkspaceFile(path, "/repo"), /Cannot delete attachment/);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.FileReader = originalReader;
  }
});

test("unsupported safe attachment APIs never fall back to legacy mutating commands", async () => {
  const originalFetch = globalThis.fetch;
  const originalReader = globalThis.FileReader;
  const calls: string[] = [];
  let projectFile = "uncommitted original";
  try {
    globalThis.FileReader = class {
      result = "data:text/plain;base64,Zml4dHVyZQ==";
      onload: (() => void) | null = null;
      readAsDataURL() { queueMicrotask(() => this.onload?.()); }
    } as unknown as typeof FileReader;
    globalThis.fetch = async url => {
      calls.push(String(url));
      if (String(url).endsWith("write_workspace_file")) {
        projectFile = "overwritten by legacy API";
        return response({ name: "original.txt", path: "original.txt" });
      }
      if (String(url).endsWith("delete_workspace_file")) {
        projectFile = "";
        return response({ success: true });
      }
      return new Response(JSON.stringify({ error: "Unknown command" }), { status: 400 });
    };
    await assert.rejects(runtimeService.writeWorkspaceFile(new File(["fixture"], "original.txt"), "/repo"));
    await assert.rejects(runtimeService.deleteWorkspaceFile("original.txt", "/repo"));
    assert.deepEqual(calls, ["/api/write_workspace_attachment", "/api/delete_workspace_attachment"]);
    assert.equal(projectFile, "uncommitted original");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.FileReader = originalReader;
  }
});

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

test("targeted snapshot reads reject a different conversation even inside the same workspace", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  let result: unknown = { ...emptySnapshot, runId: "requested", config: defaultConfig };
  try {
    globalThis.fetch = async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).runId, "requested");
      assert.ok(init?.signal, "navigation cancellation is passed through");
      return response(result);
    };
    assert.equal((await runtimeService.snapshotForRun("requested", controller.signal)).runId, "requested");
    for (const runId of ["other", "", undefined]) {
      result = { ...emptySnapshot, runId, config: defaultConfig };
      await assert.rejects(runtimeService.snapshotForRun("requested", controller.signal));
    }
    result = null;
    await assert.rejects(runtimeService.snapshotForRun("requested", controller.signal), error => error instanceof Error && !(error instanceof TypeError));
  } finally { globalThis.fetch = original; }
});

test("only explicit missing-Run responses make deletion idempotent and invalidate that Run's transcript", async () => {
  const original = globalThis.fetch;
  const key = "missing-run:execution", otherKey = "retained-run:execution";
  const cached = { text: "retained transcript", offset: 19, complete: true };
  let status = 400, error = "Run not found";
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ error }), { status });
    await assert.rejects(runtimeService.snapshotForRun("missing-run"), failure =>
      failure instanceof RunNotFoundError && failure.runId === "missing-run");
    executionTranscriptCache.set(key, cached);
    executionTranscriptCache.set(otherKey, cached);
    await runtimeService.deleteRun("missing-run");
    assert.equal(executionTranscriptCache.has(key), false);
    assert.equal(executionTranscriptCache.has(otherKey), true);

    executionTranscriptCache.set(key, cached);
    for (const failure of [
      { status: 400, error: "Cannot delete a running execution" },
      { status: 503, error: "Offline" },
      { status: 404, error: "Not found" },
    ]) {
      ({ status, error } = failure);
      await assert.rejects(runtimeService.deleteRun("missing-run"), failure => !(failure instanceof RunNotFoundError));
      assert.equal(executionTranscriptCache.has(key), true, "failed deletion must retain the transcript");
    }
    globalThis.fetch = async () => { throw new Error("Run not found"); };
    await assert.rejects(runtimeService.deleteRun("missing-run"), failure => !(failure instanceof RunNotFoundError));
    assert.equal(executionTranscriptCache.has(key), true, "a transport failure is not proof of deletion");
  } finally {
    globalThis.fetch = original;
    executionTranscriptCache.delete(key);
    executionTranscriptCache.delete(otherKey);
  }
});

test("Plan rootNodes pass through snapshot and compile APIs without translation", async () => {
  const original = globalThis.fetch;
  const plan = Object.freeze({
    executionBatches: [["root"]], rootNodes: ["root"], terminals: ["leaf"], warnings: [],
  });
  const expectedPlan = { executionBatches: [["root"]], rootNodes: ["root"], terminals: ["leaf"], warnings: [] };
  const wire = Object.freeze({ ...emptySnapshot, runId: "current-plan", plan });
  try {
    globalThis.fetch = async url => {
      const command = String(url).split("/").at(-1);
      const value = command === "compile_graph" ? plan
        : command === "bootstrap" ? { config: defaultConfig, snapshot: wire, runs: [], conversations: [], dataPath: "/mock" }
        : command === "snapshot_if_changed" ? { version: "old", snapshot: wire } : wire;
      const result = response(null);
      result.json = async () => ({ result: value });
      return result;
    };
    assert.deepEqual((await runtimeService.snapshot()).plan, expectedPlan);
    assert.deepEqual((await runtimeService.bootstrap()).snapshot.plan, expectedPlan);
    assert.deepEqual((await runtimeService.snapshotIfChanged(null)).snapshot?.plan, expectedPlan);
    assert.deepEqual(await runtimeService.compileGraph(emptySnapshot.graph), expectedPlan);
    assert.deepEqual(plan.rootNodes, ["root"]);
    assert.equal(Object.hasOwn(plan, "roots"), false);
  } finally { globalThis.fetch = original; }
});

test("current completion statuses and literal user content pass through snapshot APIs unchanged", async () => {
  const original = globalThis.fetch;
  const statuses = ["completed", "waiting", "running", "paused", "blocked", "failed", "dirty"];
  const wire = { ...emptySnapshot, runId: "legacy-label", phase: "publication_failed",
    graph: { originalGoal: "Keep done in user content", nodes: statuses.map(name => ({ id: name, task: name })), edges: [] },
    nodes: Object.fromEntries(statuses.map(status => [status, { status, revision: 1, head: "retained", instruction: "done is literal user text", error: null }])),
    extra: { evidence: "untouched" } };
  const expected = structuredClone(wire);
  try {
    globalThis.fetch = async url => {
      const command = String(url).split("/").at(-1);
      return response(command === "bootstrap" || command === "save_config"
        ? { config: defaultConfig, snapshot: wire, runs: [wire.runId], conversations: [], dataPath: "/mock" }
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
    assert.equal(wire.nodes.completed.status, "completed", "the wire fixture is not rewritten");
  } finally { globalThis.fetch = original; }
});

test("current snapshots retain identity and unsupported statuses are rejected without mutation", async () => {
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
    await assert.rejects(runtimeService.snapshot(), /Unsupported node status/);
    assert.equal(legacy.nodes.task.status, "done");
  } finally { globalThis.fetch = original; }
});

test("Planner completion streams retain current rootNodes and node status", async () => {
  const original = globalThis.fetch;
  const wire = { ...emptySnapshot, runId: "stream-label", phase: "needs_attention",
    plan: { executionBatches: [["task"]], rootNodes: ["task"], terminals: ["task"], warnings: [] },
    nodes: { task: { status: "completed", revision: 1, head: "head", instruction: "", error: null } } };
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
      assert.deepEqual(result.plan?.rootNodes, ["task"]);
      assert.equal(Object.hasOwn(result.plan!, "roots"), false);
      assert.equal(notified, result);
    }
  } finally { globalThis.fetch = original; }
});

for (const newline of ["\n", "\r\n", "\r"]) {
  test(`planning SSE accepts ${JSON.stringify(newline)} framing, multiline data and packet-split UTF-8`, async () => {
    const original = globalThis.fetch;
    const snapshot = { ...emptySnapshot, runId: "sse-framing", graph: { ...emptySnapshot.graph, originalGoal: "中文 🚀" } };
    const events: string[] = [];
    let cancelled = false;
    try {
      // A colon need not be followed by a space. Blank/comment-only frames
      // are not messages, and consecutive data fields join with newlines.
      const wire = [": keepalive", "", "event:run_started", 'data:{"runId":"sse-framing"}', "",
        "event:complete", "data: {", `data: \"snapshot\": ${JSON.stringify(snapshot)}`, "data:}", "", ": unread keepalive", "", ""].join(newline);
      globalThis.fetch = async () => new Response(new ReadableStream({
        start(controller) {
          // Split every CR/LF pair and every multibyte code point across reads.
          for (const byte of new TextEncoder().encode(wire)) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
        cancel() { cancelled = true; },
      }));
      const result = await runtimeService.planGoalStream("goal", defaultConfig, event => events.push(event.type));
      assert.deepEqual(result, snapshot);
      assert.deepEqual(events, ["run_started", "complete"]);
      assert.equal(cancelled, true, "terminal events release unread stream bytes");
    } finally { globalThis.fetch = original; }
  });
}

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

test("pickRepository surfaces rejection errors instead of falling back to window.prompt banner", async () => {
  const originalFetch = globalThis.fetch;
  const originalPrompt = globalThis.window?.prompt;
  let promptCalled = false;
  (globalThis as any).window = globalThis.window || {};
  globalThis.window.prompt = () => {
    promptCalled = true;
    return "/some/path";
  };
  try {
    const sizeLimitError = "工作区体积超过 15GB 限制。请将大型文件（例如数据集、模型权重或构建缓存）移至目录外，或进入更里层的子文件夹建立工作区。";
    globalThis.fetch = async () => new Response(JSON.stringify({ error: sizeLimitError }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
    await assert.rejects(
      runtimeService.pickRepository(),
      (err: Error) => err.message === sizeLimitError,
      "oversized workspace rejection must throw instead of falling back to path prompt"
    );
    assert.equal(promptCalled, false, "window.prompt must not be called when picker rejects a folder");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPrompt) globalThis.window.prompt = originalPrompt;
    else delete (globalThis as any).window.prompt;
  }
});

test("pickRepository returns null without prompting when native picker is cancelled", async () => {
  const originalFetch = globalThis.fetch;
  let promptCalled = false;
  (globalThis as any).window = globalThis.window || {};
  globalThis.window.prompt = () => {
    promptCalled = true;
    return "/some/path";
  };
  try {
    globalThis.fetch = async () => response({ supported: true, repository: null, cancelled: true });
    const result = await runtimeService.pickRepository();
    assert.equal(result, null);
    assert.equal(promptCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    delete (globalThis as any).window.prompt;
  }
});

test("pickRepository falls back to window.prompt only when picker is unsupported or unavailable", async () => {
  const originalFetch = globalThis.fetch;
  let promptCalled = false;
  (globalThis as any).window = globalThis.window || {};
  globalThis.window.prompt = () => {
    promptCalled = true;
    return "/manual/project";
  };
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("pick_repository")) {
        return response({ supported: false, repository: null, cancelled: false });
      }
      if (url.includes("detect_repository")) {
        return response({
          path: "/manual/project",
          name: "project",
          branch: "main",
          head: "abc",
          clean: true,
          isShadow: false,
        });
      }
      return response({});
    };
    const result = await runtimeService.pickRepository();
    assert.equal(promptCalled, true, "window.prompt must be called when picker is unsupported");
    assert.equal(result?.path, "/manual/project");
  } finally {
    globalThis.fetch = originalFetch;
    delete (globalThis as any).window.prompt;
  }
});
