#!/usr/bin/env python3
"""Generate a legacy (pre-migration) Grapher database for TC-01..TC-14.

The output schema intentionally lacks the `kind`/`execution_id` columns and
`execution_logs` table: it is the shape an old binary wrote. Every transcript
is deterministic, and `manifest.json` records the exact bytes a correct JIT or
offline migration must reproduce.
"""
import argparse
import hashlib
import json
import random
import sqlite3
from pathlib import Path

WORDS = ["路由", "编译", "调度", "快照", "工作区", "回退", "并发", "事务", "游标", "分页", "编码", "边界"]

WEIGHTS = {
    "api": 0.230, "db": 0.200, "ui": 0.170, "tests": 0.150, "docs": 0.100,
    "api-retry": 0.050, "db-retry": 0.040, "failed": 0.030, "interrupted": 0.020, "merger": 0.005,
}


def sha256_of(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def gen_text(execution_id: str, target: int, rng: random.Random) -> str:
    chunks, buf, written, index = [], [], 0, 0
    first = f"BEGIN-{execution_id}\n"
    chunks.append(first)
    written += len(first)
    while written < target:
        line = f"{index:08d} {rng.choice(WORDS)} 计划输出 🚀🎉 line-{index} \u001b[31mred\u001b[0m\n"
        buf.append(line)
        written += len(line)
        index += 1
        if sum(len(item) for item in buf) >= 1 << 20:
            chunks.append("".join(buf))
            buf = []
    chunks.append("".join(buf))
    last = f"END-{execution_id}\n"
    chunks.append(last)
    return "".join(chunks)


class Writer:
    def __init__(self, connection: sqlite3.Connection):
        self.connection = connection
        self.timestamp = 1_700_000_000_000
        self.sequence = 0

    def emit(self, run_id: str, payload: dict) -> None:
        self.sequence += 1
        self.timestamp += 37
        self.connection.execute(
            "INSERT INTO events(sequence, run_id, timestamp, payload) VALUES(?,?,?,?)",
            (self.sequence, run_id, self.timestamp, json.dumps(payload, ensure_ascii=False, separators=(",", ":"))),
        )


def execution(execution_id: str, node: str, attempt: int, before: str, head: str) -> dict:
    return {
        "id": execution_id, "node": node, "revision": 1, "attempt": attempt,
        "sessionId": execution_id, "worktree": f"/worktrees/{execution_id}",
        "before": before, "after": None, "status": "running", "output": "",
        "startedAt": 1_700_000_000_000 + attempt * 1000, "completedAt": None, "metrics": None,
    }, head


def chunked(text: str, size: int = 256 * 1024):
    position = 0
    while position < len(text):
        end = min(position + size, len(text))
        while end < len(text) and not text[end].isascii() and end > position + 1 and not _boundary(text, end):
            end -= 1
        yield text[position:end]
        position = end


def _boundary(text: str, index: int) -> bool:
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def gen_run(writer: Writer, run_id: str, nodes: list[tuple[str, str]], edges: list[tuple[str, str]],
            repository: str, base: str, size_targets: dict[str, int], rng: random.Random,
            route: str = "graph") -> dict:
    graph = {"originalGoal": f"legacy {run_id}", "nodes": [{"name": name, "task": task} for name, task in nodes],
             "edges": [{"from": a, "to": b, "relation": "", "feedback": False} for a, b in edges]}
    config = {"repository": repository, "model": "test", "maxParallel": 4, "maxFeedback": 1}
    writer.emit(run_id, {"type": "created", "graph": graph, "config": config, "planningId": None, "planning": None})
    writer.emit(run_id, {"type": "routed", "plan_type": route})
    writer.emit(run_id, {"type": "approved", "base": base})
    manifest = {"goal": graph["originalGoal"], "nodes": [name for name, _ in nodes],
                "edges": [{"from": a, "to": b} for a, b in edges], "executions": []}
    for index, (history_key, node) in enumerate([(key, key) for key in size_targets]):
        execution_id = f"{run_id}-{history_key}"
        kind = size_targets[history_key]
        target = kind["bytes"]
        text = gen_text(execution_id, target, rng)
        payload, head = execution(execution_id, node, 1, base, hashlib.sha1(execution_id.encode()).hexdigest())
        writer.emit(run_id, {"type": "started", "execution": payload})
        writer.emit(run_id, {"type": "prepared", "execution_id": execution_id, "head": base})
        for chunk in chunked(text):
            writer.emit(run_id, {"type": "output", "execution_id": execution_id, "text": chunk})
            if kind["kind"] == "finished":
                pass
        expected = text
        record = {"id": execution_id, "node": node, "bytes": len(text.encode("utf-8")), "sha256": sha256_of(text)}
        if kind["kind"] == "finished":
            writer.emit(run_id, {"type": "finished", "execution_id": execution_id, "head": head, "output": text})
            record["kind"] = "finished"
        elif kind["kind"] == "failed":
            writer.emit(run_id, {"type": "failed", "node": node, "execution_id": execution_id,
                                 "error": "legacy worker failed before finishing"})
            record["kind"] = "failed"
        elif kind["kind"] == "interrupted":
            record["kind"] = "interrupted"
        elif kind["kind"] == "merger_failed":
            expected = text + "\nMerger failed: legacy unresolved conflict\n"
            writer.emit(run_id, {"type": "merger_failed", "execution_id": execution_id,
                                 "error": "legacy unresolved conflict"})
            record["kind"] = "merger_failed"
            record["bytes"] = len(expected.encode("utf-8"))
            record["sha256"] = sha256_of(expected)
        manifest["executions"].append(record)
    writer.emit(run_id, {"type": "settled"})
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--base", required=True)
    parser.add_argument("--megabytes", type=int, default=720)
    parser.add_argument("--manifest", required=True)
    args = parser.parse_args()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()
    connection = sqlite3.connect(str(out))
    connection.execute("PRAGMA journal_mode=OFF")
    connection.execute("PRAGMA synchronous=OFF")
    connection.executescript(
        """
        CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
                            timestamp INTEGER NOT NULL, payload TEXT NOT NULL);
        CREATE INDEX events_run ON events(run_id, sequence);
        CREATE TABLE checkpoints(run_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE workspace_selection(id INTEGER PRIMARY KEY CHECK(id=1), run_id TEXT);
        """
    )
    connection.commit()
    rng = random.Random(20261001)
    writer = Writer(connection)
    runs = {}
    node_sets = {
        "legacy-run": [("api", "api"), ("db", "db"), ("ui", "ui"), ("tests", "tests"),
                       ("docs", "docs"), ("deploy", "deploy"), ("api-retry", "api"), ("db-retry", "db"),
                       ("failed", "tests"), ("interrupted", "ui"), ("merger", "tests")],
        "alpha-run": [("alpha", "alpha")],
        "beta-run": [("beta", "beta")],
        "gamma-run": [("gamma", "gamma")],
    }
    base_text_bytes = int(args.megabytes * 1024 * 1024 * 0.47)
    scale = base_text_bytes / (sum(WEIGHTS.values()) * 1024 * 1024)
    for run_id, items in node_sets.items():
        if run_id == "legacy-run":
            sizes = {}
            for key, _ in items:
                if key == "deploy":
                    sizes[key] = {"bytes": 48 * 1024, "kind": "finished"}
                elif key == "failed":
                    sizes[key] = {"bytes": int(WEIGHTS["failed"] * 1024 * 1024 * scale), "kind": "failed"}
                elif key == "interrupted":
                    sizes[key] = {"bytes": int(WEIGHTS["interrupted"] * 1024 * 1024 * scale), "kind": "interrupted"}
                elif key == "merger":
                    sizes[key] = {"bytes": int(WEIGHTS["merger"] * 1024 * 1024 * scale), "kind": "merger_failed"}
                else:
                    sizes[key] = {"bytes": int(WEIGHTS[key] * 1024 * 1024 * scale), "kind": "finished"}
            edges = [("api", "db"), ("db", "ui"), ("ui", "tests"), ("tests", "deploy"), ("docs", "deploy")]
            runs[run_id] = gen_run(writer, run_id, items, edges, args.repository, args.base, sizes, rng)
        else:
            sizes = {items[0][0]: {"bytes": 4096, "kind": "finished"}}
            runs[run_id] = gen_run(writer, run_id, items, [], args.repository, args.base, sizes, rng)
    connection.execute("INSERT INTO workspace_selection(id, run_id) VALUES(1, 'alpha-run')")
    connection.commit()
    connection.close()
    manifest = {"repository": args.repository, "base": args.base, "runs": runs}
    Path(args.manifest).write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    size = out.stat().st_size
    print(json.dumps({"database": str(out), "bytes": size, "megabytes": round(size / 1048576, 1),
                      "manifest": args.manifest, "executions": sum(len(r["executions"]) for r in runs.values())}))


if __name__ == "__main__":
    main()
