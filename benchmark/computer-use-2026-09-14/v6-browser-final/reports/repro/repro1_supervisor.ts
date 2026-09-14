// Repro 1: torn reads while save() runs. Repro 2: file left corrupt after SIGKILL mid-save.
// Steps: seed valid JSON -> spawn writer (loop of save()) -> poll file from a second process
// -> SIGKILL the writer -> inspect what survived on disk.
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, statSync, existsSync } from "node:fs";
import process from "node:process";

const target = process.argv[2] ?? "reports/repro/state.json";
const GOOD = JSON.stringify({ users: [{ id: "seed", name: "seed" }] });

writeFileSync(target, GOOD);
const child = spawn(process.execPath, ["reports/repro/repro1_writer.ts", target], { stdio: "inherit" });

const seen = new Map<string, number>(); // observed-size -> count
const poll = setInterval(() => {
  try {
    const size = statSync(target).size;
    const state = size === 0 ? "empty" : size < GOOD.length ? "smaller-than-seed" : "other:" + size;
    seen.set(state, (seen.get(state) ?? 0) + 1);
  } catch { /* gone */ }
}, 5);

const KILL_AFTER_MS = Number(process.argv[3] ?? 1200);
setTimeout(() => {
  clearInterval(poll);
  child.kill("SIGKILL");
}, KILL_AFTER_MS);

child.on("exit", (code, signal) => {
  console.log("writer_exit_signal=" + signal + " code=" + code);
  console.log("reader_observed_states=" + JSON.stringify(Object.fromEntries(seen)));
  const final = existsSync(target) ? readFileSync(target, "utf8") : "<missing>";
  let valid = false;
  try { JSON.parse(final); valid = true; } catch { /* corrupt */ }
  console.log("final_size=" + final.length + " valid_json=" + valid + " fully_written=" + (final === readFileSync(target, "utf8") && Buffer.byteLength(final) > 0 && final.endsWith("}")));
  console.log(final.length > 0 && !valid ? "RESULT: file on disk is CORRUPT/PARTIAL" : "RESULT: file " + (valid ? "valid" : "invalid") + " size=" + final.length);
});
