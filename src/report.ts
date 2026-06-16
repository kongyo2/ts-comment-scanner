import type { FileScanResult, StripResult } from "./types.js";

export function formatStripSummary(results: StripResult[]): string {
  const changed = results.filter((result) => result.changed);

  if (changed.length === 0) {
    return "No comments to remove.";
  }

  const lines = changed.map((result) => `${result.file}: ${count(result.removed, "comment")} removed`);
  const total = changed.reduce((sum, result) => sum + result.removed, 0);

  lines.push("", `${count(total, "comment")} removed across ${count(changed.length, "file")}`);
  return lines.join("\n");
}

export function formatText(results: FileScanResult[]): string {
  const withComments = results.filter((result) => result.comments.length > 0);

  if (withComments.length === 0) {
    return "No comments found.";
  }

  const lines: string[] = [];
  let total = 0;
  for (const { file, comments } of withComments) {
    for (const comment of comments) {
      lines.push(`${file}:${comment.line}:${comment.column} [${comment.kind}] ${preview(comment.text)}`);
      total += 1;
    }
  }

  lines.push("", `${count(total, "comment")} across ${count(withComments.length, "file")}`);
  return lines.join("\n");
}

function preview(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .join(" ")
    .trim();
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

export function formatJson(results: FileScanResult[]): string {
  const files = results.filter((result) => result.comments.length > 0);
  const comments = files.reduce((sum, file) => sum + file.comments.length, 0);

  return JSON.stringify({ summary: { files: files.length, comments }, files }, null, 2);
}
