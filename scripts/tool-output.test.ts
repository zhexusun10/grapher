import assert from "node:assert/strict";
import test from "node:test";
import { TOOL_OUTPUT_PREVIEW_BYTES, toolOutputPreview, truncateToolText } from "../src/services/toolOutput.ts";

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

test("tool output preserves small and exactly-at-limit strings", () => {
  for (const text of ["", "ok 中文🚀", "a".repeat(TOOL_OUTPUT_PREVIEW_BYTES)]) {
    assert.deepEqual(truncateToolText(text), { text, truncated: false });
  }
});

test("tool output caps giant ASCII, CJK and emoji at about 100 KiB with an ellipsis", () => {
  for (const unit of ["a", "中", "🚀", "a中🚀"]) {
    const input = unit.repeat(TOOL_OUTPUT_PREVIEW_BYTES + 1);
    const result = truncateToolText(input);
    assert.equal(result.truncated, true);
    assert.ok(bytes(result.text) <= TOOL_OUTPUT_PREVIEW_BYTES);
    assert.ok(result.text.endsWith("\n..."));
    assert.ok(input.startsWith(result.text.slice(0, -4)));
    assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(result.text)), result.text,
      "do not split Unicode surrogate pairs in the retained preview");
  }
});

test("tool output bounds a joined content array rather than allowing one budget per block", () => {
  const parts = [
    { type: "text", text: "a".repeat(TOOL_OUTPUT_PREVIEW_BYTES / 2) },
    { type: "image", data: "ignored" },
    { type: "text", text: "b".repeat(TOOL_OUTPUT_PREVIEW_BYTES) },
    { type: "text", text: "NEVER_RETAIN_THIS_TAIL" },
  ];
  const result = toolOutputPreview(parts);
  assert.equal(result.truncated, true);
  assert.ok(bytes(result.text) <= TOOL_OUTPUT_PREVIEW_BYTES);
  assert.ok(result.text.includes("a\nb"));
  assert.ok(result.text.endsWith("\n..."));
  assert.ok(!result.text.includes("NEVER_RETAIN_THIS_TAIL"));
  assert.deepEqual(toolOutputPreview([{ type: "text", text: "" }, { type: "text", text: "ok" }]), { text: "\nok", truncated: false });
  assert.deepEqual(toolOutputPreview(null), { text: "", truncated: false });
});
