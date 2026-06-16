import { scanComments, type ScanOptions } from "./scanner.js";
import type { Comment } from "./types.js";

const TRIPLE_SLASH_DIRECTIVE = /^\/\/\/\s*</;
const JSX_PRAGMA = /@jsx/;

function isHorizontalWhitespace(char: string): boolean {
  return char === " " || char === "\t";
}

function isIdentifierChar(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char);
}

export function isDirectiveComment(comment: Comment): boolean {
  if (comment.kind === "line" && TRIPLE_SLASH_DIRECTIVE.test(comment.text)) return true;
  return JSX_PRAGMA.test(comment.text);
}

export function stripComments(source: string, options: ScanOptions = {}): string {
  const comments = scanComments(source, options);
  if (comments.length === 0) return source;

  let result = "";
  let cursor = 0;

  for (const comment of comments) {
    if (isDirectiveComment(comment)) continue;

    const lineStart = source.lastIndexOf("\n", comment.start - 1) + 1;

    let removeStart = comment.start;
    while (removeStart > lineStart && isHorizontalWhitespace(source.charAt(removeStart - 1))) {
      removeStart -= 1;
    }

    let lineEnd = source.indexOf("\n", comment.end);
    if (lineEnd === -1) lineEnd = source.length;

    const occupiesWholeLine = removeStart === lineStart && source.slice(comment.end, lineEnd).trim() === "";

    result += source.slice(cursor, removeStart);

    if (occupiesWholeLine) {
      cursor = lineEnd < source.length ? lineEnd + 1 : lineEnd;
      continue;
    }

    const before = result.charAt(result.length - 1);
    const after = source.charAt(comment.end);
    if (isIdentifierChar(before) && isIdentifierChar(after)) {
      result += comment.text.includes("\n") ? "\n" : " ";
    }
    cursor = comment.end;
  }

  result += source.slice(cursor);
  return result;
}
