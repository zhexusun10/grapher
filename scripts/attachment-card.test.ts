import assert from "node:assert/strict";
import test from "node:test";
import { formatFileSize, parseMessageAttachmentsAndText } from "../src/utils/attachmentUtils.tsx";
import {
  extractLeadingAttachmentPrefix,
  formatManagedAttachmentDisplayLabel,
  prependAttachmentPrefix,
} from "../src/utils/attachmentPath.ts";

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

test("retired markdown attachment syntax stays ordinary message text", () => {
  const raw = `请检查附件
---
### 附件文件: test.py
\`\`\`python
print("hello world")
\`\`\``;

  const parsed = parseMessageAttachmentsAndText(raw);
  assert.equal(parsed.cleanText, raw);
  assert.deepEqual(parsed.attachments, []);
});

test("parseMessageAttachmentsAndText omits image attachment cards when images are present", () => {
  const image = { type: "image" as const, mimeType: "image/png", data: "abc", name: "shot.png" };
  const parsed = parseMessageAttachmentsAndText(
    "inspect this [图片: shot.png]",
    [
      { name: "shot.png", size: 1024, type: "image/png" },
      { name: "diagram.svg", size: 512, type: "image/svg+xml" },
      { name: "notes.txt", size: 128, type: "text/plain" },
    ],
    [image],
  );
  assert.equal(parsed.cleanText, "inspect this");
  assert.deepEqual(parsed.images, [image]);
  assert.deepEqual(parsed.attachments.map(att => att.name), ["diagram.svg", "notes.txt"]);
});

test("parseMessageAttachmentsAndText extracts and strips external managed attachment mentions", () => {
  const path = "/Users/dev/.grapher/attachment-inputs/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/report.pdf";
  const parsed = parseMessageAttachmentsAndText(`@${path} summarize this report`);
  assert.equal(parsed.cleanText, "summarize this report");
  assert.deepEqual(parsed.attachments, [{ name: "report.pdf", type: "file" }]);

  const quotedPath = "/Users/My User/.grapher/attachment-inputs/22222222-2222-4222-8222-222222222222/quarterly data.csv";
  const parsedQuoted = parseMessageAttachmentsAndText(`@${JSON.stringify(quotedPath)} check totals`);
  assert.equal(parsedQuoted.cleanText, "check totals");
  assert.deepEqual(parsedQuoted.attachments, [{ name: "quarterly data.csv", type: "file" }]);
});

test("extractLeadingAttachmentPrefix returns empty string for plain indented text without attachments", () => {
  assert.equal(extractLeadingAttachmentPrefix("   indented prompt"), "");
  assert.equal(extractLeadingAttachmentPrefix("\n\tplain text"), "");
  const path = "/Users/dev/.grapher/attachment-inputs/22222222-2222-4222-8222-222222222222/report.pdf";
  assert.equal(extractLeadingAttachmentPrefix(`@${path} follow up`), `@${path} `);
  assert.equal(extractLeadingAttachmentPrefix(`  @${path}\n\nfollow up`), `  @${path}\n\n`);
});

test("prependAttachmentPrefix inserts a separator when editing file-only messages", () => {
  const barePath = "/Users/dev/.grapher/attachment-inputs/22222222-2222-4222-8222-222222222222/report.pdf";
  const barePrefix = extractLeadingAttachmentPrefix(`@${barePath}`);
  assert.equal(barePrefix, `@${barePath}`);
  assert.equal(prependAttachmentPrefix(barePrefix, ""), `@${barePath}`);
  assert.equal(prependAttachmentPrefix(barePrefix, "summarize this"), `@${barePath} summarize this`);

  const quotedPath = "/Users/My User/.grapher/attachment-inputs/22222222-2222-4222-8222-222222222222/my report.pdf";
  const quotedPrefix = extractLeadingAttachmentPrefix(`@${JSON.stringify(quotedPath)}`);
  assert.equal(prependAttachmentPrefix(quotedPrefix, "check totals"), `@${JSON.stringify(quotedPath)} check totals`);

  // Already-delimited prefixes preserve their existing whitespace.
  assert.equal(prependAttachmentPrefix(`@${barePath} `, "edited"), `@${barePath} edited`);
  assert.equal(prependAttachmentPrefix(`@${barePath}\n\n`, "edited"), `@${barePath}\n\nedited`);
});

test("formatManagedAttachmentDisplayLabel hides internal paths and falls back to filenames", () => {
  const pathA = "/Users/dev/.grapher/attachment-inputs/22222222-2222-4222-8222-222222222222/report.pdf";
  const pathB = "/Users/dev/.grapher/attachment-inputs/33333333-3333-4333-8333-333333333333/data.csv";
  assert.equal(formatManagedAttachmentDisplayLabel(`@${pathA} Summarize Q4`), "Summarize Q4");
  assert.equal(formatManagedAttachmentDisplayLabel(`@${pathA}`), "report.pdf");
  assert.equal(formatManagedAttachmentDisplayLabel(`@${pathA} @${pathB}`), "report.pdf, data.csv");
  assert.equal(formatManagedAttachmentDisplayLabel("Plain goal title"), "Plain goal title");
});
