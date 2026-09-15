import { writeFileSync } from "node:fs";
export function save(path: string, data: string) { writeFileSync(path, data); }
