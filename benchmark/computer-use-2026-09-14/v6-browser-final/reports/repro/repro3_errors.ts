// Repro 3: error propagation of save(). Three probes:
// (a) target directory missing -> does save() throw or swallow?
// (b) overwrite of an existing good file when the write fails -> is backup preserved?
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { save } from "../../server/storage.ts";
const probe = process.argv[2];
if (probe === "missing-dir") {
  save("reports/repro/out/no/such/dir/x.json", "{}");
  console.log("NO THROW (unexpected)");
} else if (probe === "fsize") {
  // Existing valid content is replaced by a payload far above the RLIMIT_FSIZE
  // (set by caller shell), so the write must fail partway.
  writeFileSync("reports/repro/out/state.json", '{"users":[{"id":"seed","name":"seed"}]}');
  try {
    save("reports/repro/out/state.json", "x".repeat(10 * 1024 * 1024));
    console.log("SAVE_RETURNED_WITHOUT_THROW");
  } catch (e) {
    console.log("SAVE_THREW code=" + e.code + " message=" + e.message);
  }
  const after = readFileSync("reports/repro/out/state.json");
  console.log("size_after_failed_save=" + after.length + " equals_original=" + (after.toString() === '{"users":[{"id":"seed","name":"seed"}]}'));
}
