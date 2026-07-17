import { isLegalComment } from "./directives.js";
import { scanComments } from "./scanner.js";
import type { Comment } from "./types.js";

export interface RemoveOptions {
  jsx?: boolean;
  /** Also remove compiler/linter directive comments. Default: false (kept for safety). */
  removeDirectives?: boolean;
  /** Also remove license/legal comments. Default: false (kept for safety). */
  removeLegal?: boolean;
  /** Extra predicate: return false to leave a comment out of the removal entirely. */
  shouldRemove?: (comment: Comment) => boolean;
}

export interface RemoveResult {
  /** Source with the removed comments spliced out. */
  code: string;
  removed: Comment[];
  /**
   * Comments kept because they are protected: directives, license headers,
   * and comments whose removal would shift code under a next-line directive.
   */
  kept: Comment[];
  /** Comments excluded from removal by the `shouldRemove` predicate. */
  skipped: Comment[];
  changed: boolean;
}

/**
 * Removes comments from TypeScript source without touching code.
 *
 * Safety properties:
 * - AST-based ranges: strings, template literals and regexes are never affected.
 * - Directives (`@ts-expect-error`, `eslint-disable`, ...) and license headers are
 *   kept by default, since deleting them changes build/lint behaviour.
 * - A space is inserted where removing a block comment would merge two tokens,
 *   and a line break is kept where the comment acted as one (ASI stays intact).
 * - A leading byte-order mark is preserved.
 * - The result is re-scanned; if the remaining comments do not match the kept
 *   set, an error is thrown instead of returning corrupted output.
 */
export function removeComments(source: string, options: RemoveOptions = {}): RemoveResult {
  const jsx = options.jsx === true;
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom === "" ? source : source.slice(bom.length);
  const comments = scanComments(body, { jsx });

  let removed: Comment[] = [];
  const kept: Comment[] = [];
  const skipped: Comment[] = [];
  for (const comment of comments) {
    if (options.shouldRemove?.(comment) === false) {
      skipped.push(comment);
    } else if (isProtected(comment, options)) {
      kept.push(comment);
    } else {
      removed.push(comment);
    }
  }

  removed = shieldNextLineDirectives(body, removed, kept, skipped);

  if (removed.length === 0) {
    return { code: source, removed, kept, skipped, changed: false };
  }

  const code = bom + splice(body, removed);

  if (scanComments(code, { jsx }).length !== kept.length + skipped.length) {
    throw new Error("comment removal produced an unexpected result; refusing to continue");
  }

  return { code, removed, kept, skipped, changed: true };
}

function isProtected(comment: Comment, options: RemoveOptions): boolean {
  if (comment.directive !== undefined && options.removeDirectives !== true) return true;
  if (isLegalComment(comment.text) && options.removeLegal !== true) return true;
  return false;
}

/**
 * Re-protects whole-line comments sitting directly below a surviving
 * next-line directive (`@ts-expect-error`, `eslint-disable-next-line`, ...).
 * Dropping such a line would shift the following code up, silently changing
 * which line the directive applies to.
 */
function shieldNextLineDirectives(source: string, removed: Comment[], kept: Comment[], skipped: Comment[]): Comment[] {
  const shieldedLines = new Set<number>();
  for (const comment of [...kept, ...skipped]) {
    if (comment.directive !== undefined && isNextLineDirective(comment.directive)) {
      // A trailing formatter suppression (`a = [1]; // oxfmt-ignore`) targets
      // its own line, so it shields nothing below it.
      if (FORMATTER_SUPPRESSIONS.has(comment.directive) && !occupiesWholeLines(source, comment)) {
        continue;
      }
      // Counted pragmas like `c8 ignore next 3` cover several lines.
      for (let offset = 1; offset <= shieldedLineCount(comment.text); offset += 1) {
        shieldedLines.add(comment.endLine + offset);
      }
    }
  }
  if (shieldedLines.size === 0) return removed;

  const stillRemoved: Comment[] = [];
  for (const comment of removed) {
    if (shieldedLines.has(comment.line) && occupiesWholeLines(source, comment)) {
      kept.push(comment);
    } else {
      stillRemoved.push(comment);
    }
  }
  if (stillRemoved.length !== removed.length) {
    kept.sort((a, b) => a.start - b.start);
  }
  return stillRemoved;
}

// Formatter suppressions only apply to the following node when they stand on
// their own line; other next-line directives (`@ts-ignore`, ...) target the
// next line even when they trail code.
const FORMATTER_SUPPRESSIONS = new Set(["prettier-ignore", "oxfmt-ignore"]);

// File- and range-scoped pragmas (`c8 ignore start`, `istanbul ignore file`,
// ...) do not target the following line, so they never shield it.
function isNextLineDirective(name: string): boolean {
  return (
    name.endsWith("-next-line") ||
    [
      "@ts-ignore",
      "@ts-expect-error",
      "biome-ignore",
      "deno-lint-ignore",
      "deno-fmt-ignore",
      "deno-coverage-ignore",
      "prettier-ignore",
      "oxfmt-ignore",
      "istanbul-ignore",
      "istanbul-ignore-next",
      "istanbul-ignore-if",
      "istanbul-ignore-else",
      "c8-ignore",
      "c8-ignore-next",
      "c8-ignore-if",
      "c8-ignore-else",
      "v8-ignore",
      "v8-ignore-next",
      "v8-ignore-if",
      "v8-ignore-else",
      "node:coverage-ignore",
    ].includes(name)
  );
}

/** Number of following lines a next-line pragma covers (`ignore next 3` → 3). */
function shieldedLineCount(text: string): number {
  const match = /\bignore\s+next\s+(\d{1,4})\b/.exec(text);
  return match ? Math.max(1, Number(match[1])) : 1;
}

/**
 * True when nothing but whitespace shares the comment's first and last lines.
 * Lines are delimited by any ECMAScript line terminator, matching how the
 * scanner numbers them (a lone `\r`, U+2028 and U+2029 count too).
 */
function occupiesWholeLines(source: string, comment: Comment): boolean {
  for (let index = comment.start - 1; index >= 0; index -= 1) {
    const char = source[index] as string;
    if (LINE_TERMINATOR.test(char)) break;
    if (!isBlank(char)) return false;
  }
  for (let index = comment.end; index < source.length; index += 1) {
    const char = source[index] as string;
    if (LINE_TERMINATOR.test(char)) break;
    if (!isBlank(char)) return false;
  }
  return true;
}

const isBlank = (text: string): boolean => /^\s*$/.test(text);

const isHorizontalSpace = (char: string | undefined): boolean => char === " " || char === "\t";

const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

/**
 * Splices sorted, non-overlapping comment ranges out of the source, tidying lines.
 * Output is accumulated as segments with incremental line-state tracking, so the
 * work stays linear in the source size even for comment-dense files.
 */
function splice(source: string, removals: readonly Comment[]): string {
  const segments: string[] = [];
  let cursor = 0;
  /** Whether the output's current (unterminated) line is all whitespace so far. */
  let lineIsBlank = true;
  /** Last character of the output so far ("" while empty). */
  let lastChar = "";

  const push = (chunk: string): void => {
    if (chunk === "") return;
    segments.push(chunk);
    const newlineIndex = chunk.lastIndexOf("\n");
    lineIsBlank = newlineIndex === -1 ? lineIsBlank && isBlank(chunk) : isBlank(chunk.slice(newlineIndex + 1));
    lastChar = chunk.slice(-1);
  };

  /** Deletes everything the output holds after its last line break. */
  const dropCurrentLine = (): void => {
    while (segments.length > 0) {
      const last = segments[segments.length - 1] as string;
      const newlineIndex = last.lastIndexOf("\n");
      if (newlineIndex === -1) {
        segments.pop();
        continue;
      }
      segments[segments.length - 1] = last.slice(0, newlineIndex + 1);
      lineIsBlank = true;
      lastChar = "\n";
      return;
    }
    lineIsBlank = true;
    lastChar = "";
  };

  /** Deletes trailing spaces/tabs of the output's current line. */
  const trimLineEnd = (): void => {
    while (segments.length > 0) {
      const last = segments[segments.length - 1] as string;
      let end = last.length;
      while (end > 0 && isHorizontalSpace(last[end - 1])) end -= 1;
      if (end === 0) {
        segments.pop();
        continue;
      }
      if (end < last.length) segments[segments.length - 1] = last.slice(0, end);
      lastChar = (segments[segments.length - 1] as string).slice(-1);
      return;
    }
    lastChar = "";
  };

  for (const comment of removals) {
    push(source.slice(cursor, comment.start));
    cursor = comment.end;

    const newlineIndex = source.indexOf("\n", cursor);
    const lineEnd = newlineIndex === -1 ? source.length : newlineIndex + 1;
    const rest = source.slice(cursor, lineEnd);
    const eolLength = rest.endsWith("\r\n") ? 2 : rest.endsWith("\n") ? 1 : 0;
    const restContent = rest.slice(0, rest.length - eolLength);

    if (lineIsBlank && isBlank(restContent)) {
      // The comment occupied whole line(s): drop them entirely.
      dropCurrentLine();
      cursor = lineEnd;
    } else if (isBlank(restContent)) {
      // Trailing comment after code: trim the gap, keep the line break.
      trimLineEnd();
      push(rest.slice(restContent.length));
      cursor = lineEnd;
    } else if (!lineIsBlank && LINE_TERMINATOR.test(comment.text)) {
      // Code on both sides of a block comment that spans lines. Per ECMA-262
      // such a comment acts as a line terminator for semicolon insertion, so
      // replace it with a real line break (matching the file's style) instead
      // of merging the lines.
      trimLineEnd();
      push(comment.text.includes("\r\n") ? "\r\n" : "\n");
    } else {
      // Inline comment with code after it on the same line.
      const next = source.charAt(cursor);
      if (lastChar !== "" && !isBlank(lastChar) && !isBlank(next)) {
        // `a/* x */b` would merge tokens: keep them apart.
        push(" ");
      } else if (lastChar === "" || isBlank(lastChar)) {
        // Collapse the horizontal whitespace that followed the comment.
        while (cursor < lineEnd && isHorizontalSpace(source[cursor])) cursor += 1;
      }
    }
  }

  segments.push(source.slice(cursor));
  return segments.join("");
}
