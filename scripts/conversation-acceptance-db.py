"""SQLite acceptance fixtures/verification. Never write to the source database."""
import argparse
import hashlib
import json
import pathlib
import sqlite3
import subprocess
import sys


def connect(path, readonly=False):
    path = pathlib.Path(path).resolve()
    if readonly:
        return sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=30)
    path.parent.mkdir(parents=True, exist_ok=True)
    return sqlite3.connect(path, timeout=30)


def digest_events(db):
    digest = hashlib.sha256()
    count = 0
    for row in db.execute('SELECT sequence,run_id,timestamp,payload,kind,execution_id FROM events ORDER BY sequence'):
        digest.update(json.dumps(row, ensure_ascii=False, separators=(',', ':')).encode())
        count += 1
    return {'rows': count, 'sha256': digest.hexdigest()}


def source_identity(db, path):
    with pathlib.Path(path).open('rb') as stream:
        sha256 = hashlib.file_digest(stream, 'sha256').hexdigest()
    return {'path': str(path), 'bytes': pathlib.Path(path).stat().st_size, 'sha256': sha256,
            'events': digest_events(db),
            'tables': sorted(row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'"))}


def stats(db, path):
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    return {
        'fileBytes': pathlib.Path(path).stat().st_size,
        'pageCount': db.execute('PRAGMA page_count').fetchone()[0],
        'freePages': db.execute('PRAGMA freelist_count').fetchone()[0],
        'autoVacuum': db.execute('PRAGMA auto_vacuum').fetchone()[0],
        'outputEvents': db.execute("SELECT COUNT(*) FROM events WHERE COALESCE(kind,json_extract(payload,'$.type'))='output'").fetchone()[0],
        'logRows': db.execute('SELECT COUNT(*) FROM execution_logs').fetchone()[0] if 'execution_logs' in tables else 0,
    }


def log_digest(db, run, execution):
    md5 = hashlib.md5()
    pos = 0
    chunks = 0
    for offset, size, text in db.execute('SELECT offset,bytes,text FROM execution_logs WHERE run_id=? AND execution_id=? ORDER BY offset', (run, execution)):
        data = text.encode('utf-8')
        assert offset == pos, (execution, 'gap or overlap', pos, offset)
        assert len(data) == size <= 32768, (execution, 'invalid byte size', size, len(data))
        md5.update(data)
        pos += size
        chunks += 1
    return {'bytes': pos, 'md5': md5.hexdigest(), 'chunks': chunks}


def legacy_executions(db):
    result = []
    for run, payload in db.execute("SELECT run_id,payload FROM events WHERE kind IN ('started','merger_started') ORDER BY sequence"):
        event = json.loads(payload)
        execution = event['execution']
        text = execution.get('output', '')
        authoritative = False
        # The indexed branch is fast for the real database; NULL legacy rows
        # additionally exercise the pre-index compatibility path.
        rows = db.execute("SELECT payload FROM events WHERE run_id=? AND (execution_id=? OR (execution_id IS NULL AND COALESCE(json_extract(payload,'$.execution_id'),json_extract(payload,'$.execution.id'))=?)) ORDER BY sequence", (run, execution['id'], execution['id']))
        for (payload,) in rows:
            value = json.loads(payload)
            if value['type'] == 'output' and not authoritative:
                text += value['text']
            elif value['type'] == 'finished' and value.get('output'):
                text = value['output']
                authoritative = True
            elif value['type'] == 'merger_failed' and not authoritative:
                text += '\nMerger failed: ' + value['error'] + '\n'
        marker = None
        for line in reversed(text.splitlines()):
            try:
                value = json.loads(line)
                if value.get('type') == 'message_end' and value.get('message', {}).get('role') == 'assistant':
                    parts = [p.get('text', '') for p in value['message'].get('content', []) if p.get('type') == 'text']
                    if parts:
                        marker = ' '.join(''.join(parts).split())[:100]
                        break
            except (ValueError, AttributeError):
                pass
        result.append({'runId': run, 'id': execution['id'], 'node': execution['node'], 'bytes': len(text.encode()), 'md5': hashlib.md5(text.encode()).hexdigest(), 'marker': marker})
    return result


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def insert(db, run, value, timestamp=1000, indexed=True):
    kind = value['type']
    execution_id = value.get('execution_id', value.get('execution', {}).get('id'))
    db.execute('INSERT INTO events(run_id,timestamp,payload,kind,execution_id) VALUES(?,?,?,?,?)',
               (run, timestamp, encode(value), kind if indexed else None, execution_id if indexed else None))


def execution(execution_id, node, repository):
    return dict(id=execution_id, node=node, revision=1, attempt=1, sessionId=execution_id, worktree=str(repository), before='head', after=None, status='running', output='', startedAt=1000, completedAt=None)


def assistant(text):
    return encode({'type': 'message_end', 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': text}], 'usage': {'input': 7, 'output': 3, 'totalTokens': 10}, 'stopReason': 'stop'}}) + '\n'


def initialize(root, source):
    root, source = pathlib.Path(root).resolve(), pathlib.Path(source).resolve()
    assert source.is_file(), 'A real legacy --source database is required; do not silently skip TC-01'
    assert not source.is_relative_to(root), 'The acceptance directory must not contain the original source DB'
    assert not root.exists() or not any(root.iterdir()), 'Use a new empty directory for a full acceptance run'
    repository = root / 'repo'
    repository.mkdir(parents=True, exist_ok=True)
    (repository / 'base.txt').write_text('acceptance fixture\n', encoding='utf-8')
    for args in [['init', '-q'], ['add', '-A'], ['-c', 'user.name=Acceptance', '-c', 'user.email=acceptance@example.com', 'commit', '-qm', 'fixture']]:
        subprocess.run(['git', '-C', str(repository), *args], check=True, capture_output=True)
    head = subprocess.check_output(['git', '-C', str(repository), 'rev-parse', 'HEAD'], text=True).strip()
    config = {'repository': str(repository), 'model': 'test', 'maxParallel': 1, 'maxFeedback': 0}
    src = connect(source, True)
    original_identity = source_identity(src, source)
    expected_real = legacy_executions(src)
    assert expected_real and any(e['bytes'] > 20 * 1024**2 for e in expected_real)
    run = src.execute('SELECT run_id FROM workspace_selection WHERE id=1').fetchone()[0]
    graph = json.loads(src.execute("SELECT payload FROM events WHERE kind IN ('created','graph_revised','draft_edited') AND run_id=? ORDER BY sequence DESC LIMIT 1", (run,)).fetchone()[0])['graph']
    copies = {}
    for name in ['real', 'large']:
        path = root / name / 'events.sqlite'
        db = connect(path)
        src.backup(db)
        # Rebind metadata to an isolated disposable repository. Logs and source
        # event payloads in the original database are never changed.
        for sequence, payload in db.execute("SELECT sequence,payload FROM events WHERE kind IN ('created','draft_edited','started','merger_started','publishing_started')").fetchall():
            value = json.loads(payload)
            if value['type'] in ('created', 'draft_edited'):
                value['config']['repository'] = str(repository)
            elif value['type'] in ('started', 'merger_started'):
                value['execution']['worktree'] = str(repository)
            elif value['type'] == 'publishing_started':
                value['repository'] = str(repository)
            db.execute('UPDATE events SET payload=? WHERE sequence=?', (encode(value), sequence))
        db.execute('DELETE FROM checkpoints')
        db.commit()
        (root / name / 'config.json').write_text(encode(config), encoding='utf-8')
        copies[name] = {'path': str(path), 'runId': run, 'nodes': [n['name'] for n in graph['nodes']], 'executions': expected_real, 'before': stats(db, path)}
        db.close()
    src.close()
    # Restore precisely 890,000 redundant Output fragments from the real
    # Finished transcripts. Their concatenation is byte-identical to the source.
    path = pathlib.Path(copies['large']['path'])
    db = connect(path)
    db.execute('PRAGMA journal_mode=DELETE')
    db.execute('PRAGMA synchronous=OFF')  # disposable fixture construction only
    finished = db.execute("SELECT run_id,execution_id,json_extract(payload,'$.output') FROM events WHERE kind='finished' AND json_extract(payload,'$.output')!=''").fetchall()
    total_chars = sum(len(text) for _, _, text in finished)
    remaining = 890_000
    restored = 0
    for index, (run_id, execution_id, text) in enumerate(finished):
        count = remaining if index == len(finished) - 1 else max(1, round(890_000 * len(text) / total_chars))
        remaining -= count
        batch = []
        for i in range(count):
            chunk = text[i * len(text) // count:(i + 1) * len(text) // count]
            payload = encode({'type': 'output', 'execution_id': execution_id, 'text': chunk})
            batch.append((run_id, 1000, payload, 'output', execution_id))
            if len(batch) == 5000:
                db.executemany('INSERT INTO events(run_id,timestamp,payload,kind,execution_id) VALUES(?,?,?,?,?)', batch)
                db.commit()
                batch = []
        if batch:
            db.executemany('INSERT INTO events(run_id,timestamp,payload,kind,execution_id) VALUES(?,?,?,?,?)', batch)
            db.commit()
        restored += count
    copies['large']['restoredOutputRows'] = restored
    copies['large']['before'] = stats(db, path)
    assert restored == 890_000
    assert copies['large']['before']['fileBytes'] >= 720 * 1024**2, copies['large']['before']
    db.close()

    path = root / 'small' / 'events.sqlite'
    db = connect(path)
    db.executescript('''CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,timestamp INTEGER NOT NULL,payload TEXT NOT NULL,planning_id TEXT,nested_planning_id TEXT,kind TEXT,execution_id TEXT);
        CREATE INDEX events_run ON events(run_id,sequence);
        CREATE TABLE checkpoints(run_id TEXT PRIMARY KEY,sequence INTEGER NOT NULL,payload TEXT NOT NULL);
        CREATE TABLE workspace_selection(id INTEGER PRIMARY KEY,run_id TEXT);''')
    runs = []
    for name, repeats in [('alpha', 4500), ('beta', 1500), ('gamma', 2000)]:
        run_id = 'acceptance-' + name
        marker = name.upper() + '_ONLY: saved history 完成🚀'
        graph = {'originalGoal': 'Acceptance ' + name, 'nodes': [{'name': 'task', 'task': 'Acceptance ' + name}], 'edges': []}
        text = (encode({'type': 'acceptance_noise', 'text': 'x' * 1000}) + '\n') * repeats + assistant(marker)
        text += encode({'type': 'grapher_process_exited', 'elapsedMs': 2250}) + '\n\n── Final response ──\n' + marker + '\n'
        insert(db, run_id, {'type': 'created', 'graph': graph, 'config': config})
        insert(db, run_id, {'type': 'routed', 'plan_type': 'serial'})
        insert(db, run_id, {'type': 'approved', 'base': head})
        insert(db, run_id, {'type': 'started', 'execution': execution(name + '-exec', 'task', repository)})
        insert(db, run_id, {'type': 'output', 'execution_id': name + '-exec', 'text': text[:500]}, indexed=False)
        insert(db, run_id, {'type': 'finished', 'execution_id': name + '-exec', 'head': head, 'output': text}, 4000)
        insert(db, run_id, {'type': 'settled'}, 4001)
        runs.append({'id': run_id, 'executionId': name + '-exec', 'marker': marker})
    run_id = 'acceptance-failed'
    graph = {'originalGoal': 'Acceptance failed DAG', 'nodes': [{'name': name, 'task': name} for name in ['done', 'failed']], 'edges': [{'from': 'done', 'to': 'failed', 'relation': 'dependency', 'feedback': False}]}
    insert(db, run_id, {'type': 'created', 'graph': graph, 'config': config})
    insert(db, run_id, {'type': 'routed', 'plan_type': 'graph'})
    insert(db, run_id, {'type': 'approved', 'base': head})
    insert(db, run_id, {'type': 'started', 'execution': execution('done-exec', 'done', repository)})
    insert(db, run_id, {'type': 'finished', 'execution_id': 'done-exec', 'head': head, 'output': assistant('DONE_ONLY')}, 4000)
    insert(db, run_id, {'type': 'started', 'execution': execution('failed-exec', 'failed', repository)})
    text = ('长中文边界验证🚀🎉\x1b[31m失败前\x1b[0m\n' * 3000) + assistant('FAILED_ONLY: failure history preserved')
    for start in range(0, len(text), 197):
        insert(db, run_id, {'type': 'output', 'execution_id': 'failed-exec', 'text': text[start:start+197]}, indexed=False)
    insert(db, run_id, {'type': 'failed', 'node': 'failed', 'execution_id': 'failed-exec', 'error': 'fixture failure'}, 5000)
    insert(db, run_id, {'type': 'merger_started', 'execution': execution('merge-exec', 'merge:failed', repository)})
    insert(db, run_id, {'type': 'output', 'execution_id': 'merge-exec', 'text': '冲突🚀\n' * 3000}, indexed=False)
    insert(db, run_id, {'type': 'merger_failed', 'execution_id': 'merge-exec', 'error': 'unresolved fixture conflict'}, 5500)
    insert(db, run_id, {'type': 'settled'}, 6000)
    db.execute("INSERT INTO workspace_selection VALUES(1,'acceptance-alpha')")
    db.commit()
    small = {'path': str(path), 'runs': runs, 'failedRunId': run_id, 'executions': legacy_executions(db), 'before': stats(db, path)}
    db.close()
    (root / 'small' / 'config.json').write_text(encode(config), encoding='utf-8')
    manifest = {'source': original_identity, 'repository': str(repository), 'head': head, **copies, 'small': small}
    (root / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    return manifest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['init', 'identity', 'events', 'stats', 'logs', 'guards', 'unguard', 'worker-guard', 'business'])
    parser.add_argument('path')
    parser.add_argument('extra', nargs='*')
    args = parser.parse_args()
    if args.command == 'init':
        result = initialize(args.path, args.extra[0])
    else:
        writable = args.command in ['guards', 'unguard', 'worker-guard', 'business']
        db = connect(args.path, not writable)
        if args.command == 'identity': result = source_identity(db, pathlib.Path(args.path).resolve())
        elif args.command == 'events': result = digest_events(db)
        elif args.command == 'stats': result = stats(db, args.path)
        elif args.command == 'logs': result = log_digest(db, *args.extra)
        elif args.command == 'guards':
            db.executescript("CREATE TRIGGER IF NOT EXISTS acceptance_no_event_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'JIT changed events'); END; CREATE TRIGGER IF NOT EXISTS acceptance_no_event_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'JIT deleted events'); END;")
            result = {'guardsInstalled': True}
        elif args.command == 'unguard':
            db.executescript('DROP TRIGGER IF EXISTS acceptance_no_event_update; DROP TRIGGER IF EXISTS acceptance_no_event_delete;')
            result = {'guardsRemoved': True}
        elif args.command == 'worker-guard':
            db.executescript('''CREATE TRIGGER IF NOT EXISTS acceptance_finished_commit BEFORE INSERT ON events WHEN NEW.kind='finished'
                BEGIN SELECT CASE WHEN json_extract(NEW.payload,'$.output_bytes') != COALESCE((SELECT MAX(offset+bytes) FROM execution_logs WHERE execution_id=NEW.execution_id),0)
                    THEN RAISE(ABORT,'Finished committed before log bytes') END;
                SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM execution_logs WHERE execution_id=NEW.execution_id AND instr(text,'ACCEPTANCE-END|')>0)
                    THEN RAISE(ABORT,'Finished lost stdout tail') END;
                SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM execution_logs WHERE execution_id=NEW.execution_id AND instr(text,'── Final response ──')>0)
                    THEN RAISE(ABORT,'Finished lost final response') END; END;''')
            result = {'commitGuardInstalled': True}
        elif args.command == 'business':
            # A genuine run referencing a real execution, not orphan log blocks.
            original = args.extra[0]
            new = 'acceptance-business'
            import uuid
            db.execute('DELETE FROM checkpoints WHERE run_id=?', (new,))
            db.execute('DELETE FROM events WHERE run_id=?', (new,))
            mapping = {}
            for timestamp, payload, kind, execution_id in db.execute("SELECT timestamp,payload,kind,execution_id FROM events WHERE run_id=? AND kind!='output' ORDER BY sequence", (original,)).fetchall():
                value = json.loads(payload)
                if kind in ('started', 'merger_started'):
                    old = value['execution']['id']
                    mapping[old] = str(uuid.uuid4())
                    value['execution']['id'] = mapping[old]
                    value['execution']['output'] = ''
                    value['execution']['outputBytes'] = 0
                elif value.get('execution_id') in mapping:
                    value['execution_id'] = mapping[value['execution_id']]
                if kind in ('finished', 'failed', 'merger_finished', 'merger_failed'):
                    value['output_bytes'] = 0
                    value.pop('metrics', None)
                insert(db, new, value, timestamp)
            for i in range(10_000):
                insert(db, new, {'type': 'paused', 'paused': True}, 10_000 + i)
            db.commit()
            result = {'runId': new, 'rows': db.execute('SELECT COUNT(*) FROM events WHERE run_id=?', (new,)).fetchone()[0]}
        db.commit()
        db.close()
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
