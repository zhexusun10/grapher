import assert from "node:assert/strict";
import test from "node:test";
import { formatFileSize, parseMessageAttachmentsAndText } from "../src/utils/attachmentUtils.tsx";

test("formatFileSize formats bytes, KB, MB correctly", () => {
  assert.equal(formatFileSize(0), "0 B");
  assert.equal(formatFileSize(512), "512 B");
  assert.equal(formatFileSize(1024), "1.0 KB");
  assert.equal(formatFileSize(1536), "1.5 KB");
  assert.equal(formatFileSize(1024 * 1024), "1.0 MB");
  assert.equal(formatFileSize(2.5 * 1024 * 1024), "2.5 MB");
});

test("parseMessageAttachmentsAndText extracts XML <file> tags and strips raw content from cleanText", () => {
  const raw = `<file name="proposal.md">
# Project Proposal
This is the full text of the file.
</file>
完成这个markdown文档中的任务，并且根据metrics不断优化。`;

  const parsed = parseMessageAttachmentsAndText(raw);
  assert.equal(parsed.cleanText, "完成这个markdown文档中的任务，并且根据metrics不断优化。");
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].name, "proposal.md");
  assert.ok(parsed.attachments[0].content?.includes("# Project Proposal"));
  assert.ok(parsed.attachments[0].size && parsed.attachments[0].size > 0);
});

test("parseMessageAttachmentsAndText returns cleanText as empty string when user uploads only a file", () => {
  const raw = `<file name="AI_Generated_Video_Detection.docx.md">
Full document text...
</file>`;

  const parsed = parseMessageAttachmentsAndText(raw);
  assert.equal(parsed.cleanText, "");
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].name, "AI_Generated_Video_Detection.docx.md");
});

test("parseMessageAttachmentsAndText strips legacy bracket labels and preserves existingFiles", () => {
  const raw = "完成任务 [附件: AI_Proposal.docx.md]";
  const existingFiles = [{ name: "AI_Proposal.docx.md", size: 2048, type: "file" }];

  const parsed = parseMessageAttachmentsAndText(raw, existingFiles);
  assert.equal(parsed.cleanText, "完成任务");
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].name, "AI_Proposal.docx.md");
  assert.equal(parsed.attachments[0].size, 2048);
});

test("parseMessageAttachmentsAndText handles legacy markdown attachment blocks", () => {
  const raw = `请检查附件
---
### 附件文件: test.py
\`\`\`python
print("hello world")
\`\`\``;

  const parsed = parseMessageAttachmentsAndText(raw);
  assert.equal(parsed.cleanText, "请检查附件");
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].name, "test.py");
  assert.ok(parsed.attachments[0].content?.includes("print(\"hello world\")"));
});
