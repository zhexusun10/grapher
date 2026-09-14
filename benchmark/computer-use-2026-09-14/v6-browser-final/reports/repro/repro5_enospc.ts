// Repro 5: real ENOSPC mid-write on a mounted 2 MB APFS disk image.
// Seed a valid JSON file, then save() a 5 MB payload -> write fails partway.
import { writeFileSync, readFileSync } from "node:fs";
import { save } from "../../server/storage.ts";
const target = "/Volumes/TINYENOSPC/state.json";
const GOOD = JSON.stringify({ users: [{ id: "seed", name: "x".repeat(100_000) }] });
writeFileSync(target, GOOD);
console.log("seed_size=" + readFileSync(target).length);
try {
  save(target, "y".repeat(5 * 1024 * 1024));
  console.log("SAVE_RETURNED_WITHOUT_THROW");
} catch (e) {
  console.log("SAVE_THREW code=" + e.code);
}
const after = readFileSync(target);
console.log("size_after_failed_save=" + after.length + " equals_seed=false? " + (after.toString() !== GOOD) + " starts_with_y=" + (after[0] === 0x79));
