import React from "react";
import { FileCode, FileText, File } from "lucide-react";
import type { FileAttachment, ImageAttachment } from "../types";
import { findManagedAttachmentMentions, stripManagedAttachmentMentions } from "./attachmentPath";

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function getFileIcon(fileName: string) {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  const codeExts = [
    "py",
    "ipynb",
    "js",
    "jsx",
    "ts",
    "tsx",
    "json",
    "yaml",
    "yml",
    "sh",
    "bash",
    "zsh",
    "rs",
    "go",
    "cpp",
    "c",
    "h",
    "hpp",
    "java",
    "html",
    "css",
    "scss",
    "sql",
    "xml",
    "toml",
  ];
  if (codeExts.includes(ext)) {
    return <FileCode size={15} className="prompt-box-file-icon-code" />;
  }
  const textExts = ["txt", "md", "csv", "tsv", "log", "pdf", "doc", "docx", "rtf"];
  if (textExts.includes(ext)) {
    return <FileText size={15} className="prompt-box-file-icon-text" />;
  }
  return <File size={15} className="prompt-box-file-icon-generic" />;
}

const IMAGE_FILE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)$/i;
const VISION_IMAGE_FILE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const VISION_IMAGE_MIME = /^image\/(png|jpe?g|gif|webp)$/i;

function isDuplicateImageAttachmentFile(file: FileAttachment, images: readonly ImageAttachment[]): boolean {
  if (images.some((img) => img.name && img.name === file.name)) return true;
  if (file.type && VISION_IMAGE_MIME.test(file.type)) return true;
  return VISION_IMAGE_FILE_EXT.test(file.name);
}

export interface ParsedMessageAttachments {
  cleanText: string;
  attachments: FileAttachment[];
  images: ImageAttachment[];
}

/**
 * Parses out <file name="...">...</file> XML tags
 * and bracketed file references so the chat bubble never dumps raw file contents,
 * while extracting attachment metadata to render an attachment badge card.
 */
export function parseMessageAttachmentsAndText(
  rawText: string,
  existingFiles?: FileAttachment[],
  existingImages?: ImageAttachment[]
): ParsedMessageAttachments {
  let cleanText = rawText || "";
  const attachments: FileAttachment[] = existingFiles ? [...existingFiles] : [];
  const images: ImageAttachment[] = existingImages ? [...existingImages] : [];

  // Managed external attachment mentions (`@<data_root>/attachment-inputs/...`)
  for (const mention of findManagedAttachmentMentions(cleanText)) {
    const fileName = mention.name;
    const isImage = IMAGE_FILE_EXT.test(fileName);
    if (!attachments.some((a) => a.name === fileName || a.name === mention.path)) {
      attachments.push({
        name: fileName,
        type: isImage ? "image" : "file",
      });
    }
  }
  cleanText = stripManagedAttachmentMentions(cleanText);

  // XML tags: <file name="...">content</file> or <file name="..."></file>
  const fileTagRegex = /<file name="([^"]+)">([\s\S]*?)<\/file>\s*/g;
  let match: RegExpExecArray | null;
  while ((match = fileTagRegex.exec(cleanText)) !== null) {
    const fullName = match[1].trim();
    const fileName = fullName.split(/[/\\]/).pop() || fullName;
    const content = match[2];
    const isImage = /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(fileName);
    if (!attachments.some((a) => a.name === fileName || a.name === fullName)) {
      attachments.push({
        name: fileName,
        size: content ? new Blob([content]).size : undefined,
        type: isImage ? "image" : "file",
        content,
      });
    }
  }
  cleanText = cleanText.replace(fileTagRegex, "");

  // Bracketed labels: [附件: filename] or [Attachment: filename]
  const bracketRegex = /\s*\[(?:附件|图片|Attachment):\s*([^\]]+)\]/gi;
  while ((match = bracketRegex.exec(cleanText)) !== null) {
    const fullName = match[1].trim();
    const fileName = fullName.split(/[/\\]/).pop() || fullName;
    if (!attachments.some((a) => a.name === fileName || a.name === fullName)) {
      attachments.push({ name: fileName, type: "file" });
    }
  }
  cleanText = cleanText.replace(bracketRegex, "");

  // Filename brackets like [name.ext] at the end or inline
  const filenameBracketRegex = /\s*\[([a-zA-Z0-9_\-. ]+\.(?:docx\.md|md|py|txt|json|ts|tsx|js|jsx|pdf|csv|log|png|jpe?g|gif|webp))\]/gi;
  while ((match = filenameBracketRegex.exec(cleanText)) !== null) {
    const fullName = match[1].trim();
    const fileName = fullName.split(/[/\\]/).pop() || fullName;
    if (!attachments.some((a) => a.name === fileName || a.name === fullName)) {
      attachments.push({ name: fileName, type: "file" });
    }
  }
  cleanText = cleanText.replace(filenameBracketRegex, "");

  const filteredAttachments = images.length > 0
    ? attachments.filter((att) => !isDuplicateImageAttachmentFile(att, images))
    : attachments;

  return {
    cleanText: cleanText.trim(),
    attachments: filteredAttachments,
    images,
  };
}

/**
 * Renders an attachment badge identical in styling to the prompt input box file preview badge.
 */
export function AttachmentCard({ file }: { file: FileAttachment }) {
  return (
    <div className="prompt-box-file-badge chat-bubble-file-badge" title={file.name}>
      <span className="prompt-box-file-icon">
        {getFileIcon(file.name)}
      </span>
      <div className="prompt-box-file-info">
        <span className="prompt-box-file-name" title={file.name}>
          {file.name}
        </span>
        {file.size !== undefined && file.size > 0 ? (
          <span className="prompt-box-file-size">
            {formatFileSize(file.size)}
          </span>
        ) : null}
      </div>
    </div>
  );
}
