export function importRows(text: string) { return text.split("\n").map(line => line.split(",")); }
