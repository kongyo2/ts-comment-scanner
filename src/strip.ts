import { scanComments, type ScanOptions } from "./scanner.js";

function isHorizontalWhitespace(char: string): boolean {
  return char === " " || char === "\t";
}

export function stripComments(source: string, options: ScanOptions = {}): string {
  const comments = scanComments(source, options);
  if (comments.length === 0) return source;

  let result = "";
  let cursor = 0;

  for (const comment of comments) {
    const lineStart = source.lastIndexOf("\n", comment.start - 1) + 1;

    let removeStart = comment.start;
    while (removeStart > lineStart && isHorizontalWhitespace(source.charAt(removeStart - 1))) {
      removeStart -= 1;
    }

    let lineEnd = source.indexOf("\n", comment.end);
    if (lineEnd === -1) lineEnd = source.length;

    let removeEnd = comment.end;
    const occupiesWholeLine = removeStart === lineStart && source.slice(comment.end, lineEnd).trim() === "";
    if (occupiesWholeLine) {
      removeEnd = lineEnd < source.length ? lineEnd + 1 : lineEnd;
    }

    result += source.slice(cursor, removeStart);
    cursor = removeEnd;
  }

  result += source.slice(cursor);
  return result;
}
