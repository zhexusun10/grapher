// Repro 1/2 writer: repeatedly overwrite `target` via server/storage.save().
// Payload is large so the in-flight window of writeFileSync is wide.
import process from "node:process";
import { save } from "../../server/storage.ts";

const target = process.argv[2];
const payload = JSON.stringify({ users: Array.from({ length: 250_000 }, (_, i) => ({ id: "u" + i, name: "n".repeat(800) })) });
console.log("payload_bytes=" + Buffer.byteLength(payload));
for (let i = 0; i < 60; i++) {
  save(target, payload);
}
