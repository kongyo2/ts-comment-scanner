import { Buffer } from "node:buffer";
import type { Comment, FileScanResult } from "./types.js";

/** Formats `3 comments`, `1 file`, ... with naive pluralization. */
export function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function renderComments(results: FileScanResult[], renderLine: (file: string, comment: Comment) => string): string {
  const lines: string[] = [];
  let total = 0;
  let fileCount = 0;

  for (const { file, comments } of results) {
    if (comments.length === 0) continue;
    fileCount += 1;
    for (const comment of comments) {
      lines.push(renderLine(file, comment));
      total += 1;
    }
  }

  if (total === 0) {
    return "No comments found.";
  }

  lines.push("", `${count(total, "comment")} across ${count(fileCount, "file")}`);
  return lines.join("\n");
}

export function formatText(results: FileScanResult[]): string {
  return renderComments(results, (file, comment) => {
    const tag = comment.directive === undefined ? "" : ` [${comment.directive}]`;
    return `${file}:${comment.line}:${comment.column} [${comment.kind}]${tag} ${preview(comment.text)}`;
  });
}

function preview(text: string): string {
  // Split on every ECMAScript line terminator so exotic breaks (lone \r,
  // U+2028/U+2029) cannot leak raw control characters into terminal output.
  return text
    .split(/\r\n|[\n\r\u2028\u2029]/)
    .map((line) => line.trim())
    .join(" ")
    .trim();
}

export function formatJson(results: FileScanResult[]): string {
  const files = results.filter((result) => result.comments.length > 0);
  const comments = files.reduce((sum, file) => sum + file.comments.length, 0);
  const directives = files.reduce(
    (sum, file) => sum + file.comments.filter((comment) => comment.directive !== undefined).length,
    0,
  );

  return JSON.stringify({ summary: { files: files.length, comments, directives }, files }, null, 2);
}

/**
 * Formats results as GitHub Actions workflow commands so each comment shows up
 * as an annotation on the corresponding file and line in CI.
 * See https://docs.github.com/actions/reference/workflow-commands-for-github-actions
 */
export function formatGitHub(results: FileScanResult[]): string {
  return renderComments(results, annotation);
}

function annotation(file: string, comment: Comment): string {
  const title =
    comment.directive === undefined ? `${comment.kind} comment` : `${comment.kind} comment (${comment.directive})`;
  const properties = [`file=${escapeProperty(file)}`, `line=${comment.line}`, `endLine=${comment.endLine}`];
  if (comment.line === comment.endLine) {
    // The scanner's endColumn is exclusive, GitHub's annotation columns are
    // inclusive (a 6-character token at columns 5–10 is reported end_column
    // 10 by the Checks API), so the last covered column is endColumn - 1.
    properties.push(`col=${comment.column}`, `endColumn=${comment.endColumn - 1}`);
  }
  properties.push(`title=${escapeProperty(title)}`);
  return `::notice ${properties.join(",")}::${escapeData(truncateAnnotationMessage(comment.text))}`;
}

// GitHub rejects annotation messages over 64 KiB; truncate on a code-point
// boundary with room to spare so huge comments still annotate.
const MAX_ANNOTATION_MESSAGE_BYTES = 60_000;
const TRUNCATION_SUFFIX = "… (truncated)";

function truncateAnnotationMessage(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_ANNOTATION_MESSAGE_BYTES) return text;
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > MAX_ANNOTATION_MESSAGE_BYTES) break;
    bytes += size;
    end += char.length;
  }
  return `${text.slice(0, end)}${TRUNCATION_SUFFIX}`;
}

function escapeData(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function escapeProperty(value: string): string {
  return escapeData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}
