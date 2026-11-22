import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DESKTOP_NOTIFICATION_CLICKED_EVENT,
  extractLastAssistantTextFromTranscript,
  formatNotificationBody,
  getNotificationPermissionStatus,
  isCompletionNotificationPhase,
  isWindowUnfocused,
  openDesktopNotificationSettings,
  requestBrowserNotificationPermission,
  resolveFinalAgentOutput,
  selectFinalOutputSources,
  sendCompletionNotification,
  subscribeDesktopNotificationClicks,
  type DesktopNotificationClickPayload,
} from '../src/services/completionNotifications.ts';
import type { Execution, Snapshot } from '../src/types.ts';

function makeExecution(overrides: Partial<Execution> = {}): Execution {
  return {
    id: 'exec-1',
    node: 'task',
    revision: 1,
    attempt: 1,
    sessionId: 'sess-1',
    worktree: '/tmp/wt',
    before: 'abc',
    after: 'def',
    workspaceLineage: [],
    input: null,
    result: null,
    status: 'completed',
    startedAt: 1000,
    completedAt: 2000,
    output: '',
    outputBytes: 0,
    pid: null,
    metrics: null,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    runId: 'run-1',
    graph: { originalGoal: 'Ship notifications', nodes: [], edges: [] },
    config: null,
    plan: null,
    nodes: {},
    executions: [],
    mergers: [],
    events: [],
    approved: false,
    paused: false,
    phase: 'completed',
    base: '',
    feedbackCounts: {},
    ...overrides,
  };
}

function withDesktopGlobal<T>(
  invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null,
  fn: () => Promise<T> | T,
): Promise<T> {
  const host = globalThis as Record<string, unknown>;
  const hadIsTauri = 'isTauri' in host;
  const hadInternals = '__TAURI_INTERNALS__' in host;
  const prevIsTauri = host.isTauri;
  const prevInternals = host.__TAURI_INTERNALS__;
  if (invoke) {
    host.isTauri = true;
    host.__TAURI_INTERNALS__ = { invoke };
  } else {
    delete host.isTauri;
    delete host.__TAURI_INTERNALS__;
  }
  return Promise.resolve().then(fn).finally(() => {
    if (hadIsTauri) host.isTauri = prevIsTauri;
    else delete host.isTauri;
    if (hadInternals) host.__TAURI_INTERNALS__ = prevInternals;
    else delete host.__TAURI_INTERNALS__;
  });
}

test('isCompletionNotificationPhase distinguishes completed turns from transient or paused phases', () => {
  assert.equal(isCompletionNotificationPhase('completed'), true);
  assert.equal(isCompletionNotificationPhase('followup'), true);
  assert.equal(isCompletionNotificationPhase('awaiting_approval', { planType: 'graph', config: null }), true);
  assert.equal(isCompletionNotificationPhase('awaiting_approval', { planType: 'serial', config: null }), false);
  assert.equal(
    isCompletionNotificationPhase('awaiting_approval', {
      planType: 'graph',
      config: { repository: '/repo', model: 'm', thinkingLevel: 'medium', maxParallel: 2, maxFeedback: 2, autoApprove: true },
    }),
    false,
  );
  for (const phase of ['planning', 'running', 'publishing', 'merging', 'paused', 'draft', 'rejected', 'needs_attention', 'planning_failed']) {
    assert.equal(isCompletionNotificationPhase(phase), false, phase);
  }
});

test('extractLastAssistantTextFromTranscript returns the final assistant reply while skipping thinking and tools', () => {
  const jsonl = [
    JSON.stringify({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'Please check this' }] } }),
    JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'internal thoughts' }, { type: 'text', text: 'First step done.' }] } }),
    JSON.stringify({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } }),
    JSON.stringify({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result: { content: [{ type: 'text', text: 'file.ts' }] }, isError: false }),
    JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'All tests passed. Should I also update the README?' }] } }),
  ].join('\n');
  assert.equal(
    extractLastAssistantTextFromTranscript(jsonl),
    'All tests passed. Should I also update the README?',
  );

  // Leading partial JSONL fragments from mid-log tail reads must not leak raw JSON.
  const partialTailOnly = [
    '","timestamp":1700000000}',
    JSON.stringify({ type: 'tool_execution_end', toolCallId: 't2', toolName: 'bash', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false }),
  ].join('\n');
  assert.equal(extractLastAssistantTextFromTranscript(partialTailOnly, true), '');

  const partialTailWithReply = [
    '","timestamp":1700000000}',
    JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Done after long log.' }] } }),
  ].join('\n');
  assert.equal(extractLastAssistantTextFromTranscript(partialTailWithReply, true), 'Done after long log.');
});

test('formatNotificationBody strips Markdown noise and truncates long output cleanly', () => {
  const markdown = '## Summary\n\nUpdated **SettingsModal** (`src/App.tsx`) — see [docs](https://example.com).\n```ts\nconst x = 1;\n```';
  assert.equal(
    formatNotificationBody(markdown, 200),
    'Summary Updated SettingsModal (src/App.tsx) — see docs. const x = 1;',
  );
  assert.equal(formatNotificationBody('你好世界，这是一条很长的回复内容', 6), '你好世界，…');
  assert.equal(formatNotificationBody('   \n\t  ', 50), '');
});

test('selectFinalOutputSources and resolveFinalAgentOutput pick the newest completed agent source', async () => {
  const olderExec = makeExecution({ id: 'exec-old', completedAt: 1000 });
  const newerExec = makeExecution({ id: 'exec-new', completedAt: 5000 });
  const snapshot = makeSnapshot({
    executions: [olderExec, newerExec],
    planningId: 'plan-1',
    events: [{ sequence: 1, timestamp: 3000, type: 'planning_completed', planning_id: 'plan-1' }],
  });
  const sources = selectFinalOutputSources(snapshot);
  assert.equal(sources[0].kind, 'execution');
  if (sources[0].kind === 'execution') assert.equal(sources[0].execution.id, 'exec-new');
  assert.equal(sources[1].kind, 'planning');

  // Post-task Planner review newer than the execution takes precedence.
  const reviewSnapshot = makeSnapshot({
    executions: [newerExec],
    planningId: 'plan-review',
    events: [{ sequence: 2, timestamp: 9000, type: 'planning_completed', planning_id: 'plan-review' }],
  });
  const reviewSources = selectFinalOutputSources(reviewSnapshot);
  assert.equal(reviewSources[0].kind, 'planning');
  if (reviewSources[0].kind === 'planning') assert.equal(reviewSources[0].planningId, 'plan-review');

  const text = await resolveFinalAgentOutput('run-1', reviewSnapshot, {
    async getExecutionOutput() {
      return JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Execution finished' }] } });
    },
    async getPlanningOutput() {
      return JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Review complete — ready for your feedback?' }] } });
    },
  });
  assert.equal(text, 'Review complete — ready for your feedback?');

  // Falls back to execution output when primary planning output is empty.
  const fallbackText = await resolveFinalAgentOutput('run-1', reviewSnapshot, {
    async getExecutionOutput() {
      return JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Fallback execution reply' }] } });
    },
    async getPlanningOutput() {
      return '';
    },
  });
  assert.equal(fallbackText, 'Fallback execution reply');
});

test('isWindowUnfocused reflects visibilityState, hidden, and hasFocus', () => {
  assert.equal(isWindowUnfocused({ hidden: false, visibilityState: 'visible', hasFocus: () => true }), false);
  assert.equal(isWindowUnfocused({ hidden: false, visibilityState: 'visible', hasFocus: () => false }), true);
  assert.equal(isWindowUnfocused({ hidden: true, visibilityState: 'hidden', hasFocus: () => true }), true);
});

test('sendCompletionNotification delegates to send_desktop_notification IPC in Tauri desktop mode', async () => {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  await withDesktopGlobal(async (cmd, args) => {
    calls.push({ cmd, args });
    return true;
  }, async () => {
    const sent = await sendCompletionNotification({
      title: 'Fix macOS drag-and-drop',
      body: '**Done** — do you want me to rebuild the bundle?',
      runId: 'run-42',
      sound: false,
    });
    assert.equal(sent, true);
    assert.deepEqual(calls, [{
      cmd: 'send_desktop_notification',
      args: {
        title: 'Fix macOS drag-and-drop',
        body: 'Done — do you want me to rebuild the bundle?',
        runId: 'run-42',
        sound: false,
      },
    }]);
  });
});

test('subscribeDesktopNotificationClicks handles live events, drains buffered clicks, and deduplicates by seq', async () => {
  const opened: string[] = [];
  let listener: ((event: { payload: DesktopNotificationClickPayload }) => void) | null = null;
  let unlistened = false;
  await withDesktopGlobal(async (cmd) => {
    if (cmd === 'take_pending_notification_click') {
      return { runId: 'run-buffered', seq: 2 };
    }
    throw new Error(`unexpected cmd: ${cmd}`);
  }, async () => {
    const stop = subscribeDesktopNotificationClicks(
      (runId) => opened.push(runId),
      {
        listenFn: async (eventName, handler) => {
          assert.equal(eventName, DESKTOP_NOTIFICATION_CLICKED_EVENT);
          listener = handler;
          return () => { unlistened = true; };
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(opened, ['run-buffered']);

    // Duplicate seq from a racing live event is ignored.
    listener?.({ payload: { runId: 'run-buffered', seq: 2 } });
    assert.deepEqual(opened, ['run-buffered']);

    // Newer live click opens its target conversation.
    listener?.({ payload: { runId: 'run-live', seq: 3 } });
    assert.deepEqual(opened, ['run-buffered', 'run-live']);

    stop();
    assert.equal(unlistened, true);
  });
});

test('desktop notification permission helpers delegate to native IPC and normalize prompt to default', async () => {
  const calls: string[] = [];
  let statusResponse = 'prompt';
  let requestResponse = 'granted';
  await withDesktopGlobal(async (cmd) => {
    calls.push(cmd);
    if (cmd === 'desktop_notification_permission_status') return statusResponse;
    if (cmd === 'request_desktop_notification_permission') return requestResponse;
    if (cmd === 'open_desktop_notification_settings') return null;
    throw new Error(`unexpected cmd: ${cmd}`);
  }, async () => {
    assert.equal(await getNotificationPermissionStatus(), 'default');
    statusResponse = 'denied';
    assert.equal(await getNotificationPermissionStatus(), 'denied');
    assert.equal(await requestBrowserNotificationPermission(), 'granted');
    requestResponse = 'denied';
    assert.equal(await requestBrowserNotificationPermission(), 'denied');
    assert.equal(await openDesktopNotificationSettings(), true);
    assert.deepEqual(calls, [
      'desktop_notification_permission_status',
      'desktop_notification_permission_status',
      'request_desktop_notification_permission',
      'request_desktop_notification_permission',
      'open_desktop_notification_settings',
    ]);
  });

  await withDesktopGlobal(null, async () => {
    assert.equal(await openDesktopNotificationSettings(), false);
  });
});

test('sendCompletionNotification uses Web Notification API in browser mode only when unfocused and granted', async () => {
  const host = globalThis as Record<string, unknown>;
  const prevDoc = host.document;
  const prevNotification = host.Notification;
  const created: Array<{ title: string; body?: string; silent?: boolean; instance: FakeNotification }> = [];

  class FakeNotification {
    static permission: NotificationPermission = 'granted';
    onclick: (() => void) | null = null;
    closed = false;
    constructor(title: string, options?: NotificationOptions) {
      created.push({ title, body: options?.body, silent: options?.silent, instance: this });
    }
    close() {
      this.closed = true;
    }
  }

  try {
    host.Notification = FakeNotification;
    await withDesktopGlobal(null, async () => {
      // Focused tab: suppressed.
      host.document = { hidden: false, visibilityState: 'visible', hasFocus: () => true };
      assert.equal(await sendCompletionNotification({ title: 'Chat', body: 'Ready?' }), false);
      assert.equal(created.length, 0);

      // Unfocused tab + granted permission: sent with sound option and click callback.
      const clickedRuns: Array<string | undefined> = [];
      host.document = { hidden: false, visibilityState: 'visible', hasFocus: () => false };
      assert.equal(
        await sendCompletionNotification({
          title: 'Chat',
          body: 'Ready?',
          runId: 'run-7',
          sound: false,
          onClick: (runId) => clickedRuns.push(runId),
        }),
        true,
      );
      assert.equal(created.length, 1);
      assert.equal(created[0].title, 'Chat');
      assert.equal(created[0].body, 'Ready?');
      assert.equal(created[0].silent, true);
      created[0].instance.onclick?.();
      assert.deepEqual(clickedRuns, ['run-7']);
      assert.equal(created[0].instance.closed, true);

      // Denied permission: suppressed.
      FakeNotification.permission = 'denied';
      assert.equal(await sendCompletionNotification({ title: 'Chat', body: 'Another?' }), false);
      assert.equal(created.length, 1);
    });
  } finally {
    if (prevDoc === undefined) delete host.document;
    else host.document = prevDoc;
    if (prevNotification === undefined) delete host.Notification;
    else host.Notification = prevNotification;
  }
});
