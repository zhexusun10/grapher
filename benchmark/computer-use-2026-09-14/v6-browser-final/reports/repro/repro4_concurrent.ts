// Repro 4: two processes call save() concurrently on the same file with distinct
// payloads of unequal size. Does the final content equal one complete payload?
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import process from "node:process";
const target = "reports/repro/out/concurrent.json";
const make = (ch: string, len: number, tail: string) => ch.repeat(len) + tail;
const A = make("A", 8 * 1024 * 1024, "|END-A");
const B = make("B", 4 * 1024 * 1024, "|END-B");
writeFileSync(target, "seed");
const writerSrc = (ch: string, len: number, tail: string) =>
  `import { save } from "../../../server/storage.ts";\nimport process from "node:process";\nconst p = "${ch}".repeat(${len}) + "${tail}";\nfor (let i = 0; i < 60; i++) save(process.argv[2], p);\n`;
writeFileSync("reports/repro/out/wA.ts", writerSrc("A", 8 * 1024 * 1024, "|END-A"));
writeFileSync("reports/repro/out/wB.ts", writerSrc("B", 4 * 1024 * 1024, "|END-B"));
const kids = ["reports/repro/out/wA.ts", "reports/repro/out/wB.ts"].map(f =>
  spawn(process.execPath, [f, target], { stdio: "ignore" }));
await Promise.all(kids.map(k => new Promise(r => k.on("exit", r))));
const final = readFileSync(target, "utf8");
const isA = final === A, isB = final === B;
console.log("final_len=" + final.length + " is_exact_A=" + isA + " is_exact_B=" + isB);
if (!isA && !isB) {
  const counts: Record<string, number> = {};
  for (const ch of final) counts[ch] = (counts[ch] ?? 0) + 1;
  console.log("byte_histogram=" + JSON.stringify(counts) + " tail=" + JSON.stringify(final.slice(-10)));
  console.log("RESULT: FINAL CONTENT IS A MIX/TORN WRITE (neither writer's payload survived intact)");
}
