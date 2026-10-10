import assert from "node:assert/strict";
import { marked } from "marked";
import { StreamingMarkdownCache, repairStreamingMarkdown, sanitizeHtml } from "../src/services/streamingMarkdown.ts";

// Synthetic CPU-only probe: no backend, provider, credentials or runtime history.
const history = Array.from({ length: 500 }, (_, index) =>
  `Paragraph ${index}: **bold** [link](https://example.test/${index}).\n\n`).join("");
const updates = Array.from({ length: 100 }, (_, index) => history + "Tail " + "x".repeat(index));
const fullParse = (text: string) => sanitizeHtml(marked.parse(repairStreamingMarkdown(text), { gfm: true, breaks: true }) as string);
const expected = fullParse(updates.at(-1)!);
function measure(cached: boolean) {
  const cache = new StreamingMarkdownCache();
  const start = performance.now();
  let output = "";
  for (const text of updates) output = cached ? cache.render(text, true) : fullParse(text);
  const milliseconds = performance.now() - start;
  assert.equal(output, expected);
  return milliseconds;
}
measure(false); measure(true); // Warm both paths before alternating measured runs.
const baseline: number[] = [], optimized: number[] = [];
for (let round = 0; round < 5; round++) {
  baseline.push(measure(false)); optimized.push(measure(true));
}
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
console.log(JSON.stringify({
  scenario: "500 completed Markdown paragraphs; 100 growing-tail updates",
  baselineMs: baseline, optimizedMs: optimized,
  baselineMedianMs: median(baseline), optimizedMedianMs: median(optimized),
  note: "Local synthetic parsing timings, not application latency or provider throughput.",
}, null, 2));
