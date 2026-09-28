import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionManager } from '../pi/packages/coding-agent/src/core/session-manager.ts';

test('Pi reloads a Grapher edit marker at the parent of the edited user turn', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grapher-tree-'));
  try {
    const sessionId = randomUUID();
    const path = join(dir, `test_${sessionId}.jsonl`);
    const timestamp = new Date().toISOString();
    const entries = [
      { type: 'session', version: 3, id: sessionId, cwd: dir, timestamp },
      { type: 'message', id: 'root', parentId: null, timestamp, message: { role: 'user', content: 'first', timestamp: 100 } },
      { type: 'message', id: 'answer', parentId: 'root', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'first result' }], timestamp: 101 } },
      { type: 'message', id: 'old', parentId: 'answer', timestamp, message: { role: 'user', content: 'old instruction', timestamp: 102 } },
      { type: 'message', id: 'old-answer', parentId: 'old', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'old result' }], timestamp: 103 } },
      { type: 'custom', id: 'edit', parentId: 'answer', timestamp, customType: 'grapher-edit', data: { fromId: 'old-answer' } },
    ];
    writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
    const session = SessionManager.open(path, dir);
    assert.equal(session.getLeafId(), 'edit');
    assert.deepEqual(session.getBranch().map(e => e.id), ['root', 'answer', 'edit']);
    assert.equal(session.getEntries().length, 5, 'the abandoned branch stays in the session tree');
    assert.deepEqual(session.buildSessionContext().messages.filter(m => m.role === 'user').map(m => m.content), ['first']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
