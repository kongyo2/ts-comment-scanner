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
    properties.push(`col=${comment.column}`, `endColumn=${comment.endColumn}`);
  }
  properties.push(`title=${escapeProperty(title)}`);
  return `::notice ${properties.join(",")}::${escapeData(comment.text)}`;
}

function escapeData(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function escapeProperty(value: string): string {
  return escapeData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}
