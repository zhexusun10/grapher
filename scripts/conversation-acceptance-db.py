"""Read-only current-format log checks, plus guards on disposable acceptance DBs."""
import argparse
import hashlib
import json
import pathlib
import sqlite3


def log_digest(db, run, execution):
    digest = hashlib.md5()
    offset = chunks = 0
    for start, size, text in db.execute(
        'SELECT offset,bytes,text FROM execution_logs WHERE run_id=? AND execution_id=? ORDER BY offset',
        (run, execution),
    ):
        data = text.encode('utf-8')
        assert start == offset, (execution, 'non-contiguous log', offset, start)
        assert len(data) == size <= 32768, (execution, 'invalid log chunk', size)
        digest.update(data)
        offset += size
        chunks += 1
    return {'bytes': offset, 'md5': digest.hexdigest(), 'chunks': chunks}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['events', 'stats', 'logs', 'guards', 'unguard', 'worker-guard'])
    parser.add_argument('path')
    parser.add_argument('extra', nargs='*')
    args = parser.parse_args()
    path = pathlib.Path(args.path).resolve()
    writable = args.command in ['guards', 'unguard', 'worker-guard']
    with sqlite3.connect(path.as_uri() + ('?mode=rw' if writable else '?mode=ro'), uri=True, timeout=30) as db:
        assert db.execute('PRAGMA user_version').fetchone()[0] == 1, 'Unsupported acceptance database format'
        if args.command == 'events':
            digest = hashlib.sha256()
            count = 0
            for row in db.execute('SELECT sequence,run_id,timestamp,payload,kind,execution_id FROM events ORDER BY sequence'):
                digest.update(json.dumps(row, ensure_ascii=False, separators=(',', ':')).encode())
                count += 1
            result = {'rows': count, 'sha256': digest.hexdigest()}
        elif args.command == 'stats':
            result = {'fileBytes': path.stat().st_size,
                      'pageCount': db.execute('PRAGMA page_count').fetchone()[0],
                      'logRows': db.execute('SELECT COUNT(*) FROM execution_logs').fetchone()[0]}
        elif args.command == 'logs':
            result = log_digest(db, *args.extra)
        elif args.command == 'guards':
            db.executescript("CREATE TRIGGER acceptance_no_event_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'Read changed events'); END; CREATE TRIGGER acceptance_no_event_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'Read deleted events'); END;")
            result = {'guardsInstalled': True}
        elif args.command == 'unguard':
            db.executescript('DROP TRIGGER IF EXISTS acceptance_no_event_update; DROP TRIGGER IF EXISTS acceptance_no_event_delete;')
            result = {'guardsRemoved': True}
        else:
            db.executescript('''CREATE TRIGGER acceptance_finished_commit BEFORE INSERT ON events WHEN NEW.kind='finished'
                BEGIN SELECT CASE WHEN json_extract(NEW.payload,'$.output_bytes') != COALESCE((SELECT MAX(offset+bytes) FROM execution_logs WHERE execution_id=NEW.execution_id),0)
                    THEN RAISE(ABORT,'Finished committed before log bytes') END;
                SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM execution_logs WHERE execution_id=NEW.execution_id AND instr(text,'ACCEPTANCE-END|')>0)
                    THEN RAISE(ABORT,'Finished lost stdout tail') END;
                SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM execution_logs WHERE execution_id=NEW.execution_id AND instr(text,'── Final response ──')>0)
                    THEN RAISE(ABORT,'Finished lost final response') END; END;''')
            result = {'commitGuardInstalled': True}
        print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
