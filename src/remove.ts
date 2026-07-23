import { activePositionalDirectives, isLegalComment, type DirectivePlacement } from "./directives.js";
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
   * comments whose removal would shift code under a next-line directive, and
   * comments whose removal would move a position-dependent directive
   * (prettier's first-comment pragma, Bun's file-start marker) into effect.
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
 * - Surviving comments keep their directive semantics: when deleting a leading
 *   comment would newly activate a position-dependent directive in a kept
 *   comment (prettier's `@format` docblock pragma counts only as the file's
 *   first comment, Bun's `// @bun` only at the very start), the leading
 *   comment is kept instead.
 * - A space is inserted where removing a block comment would merge two tokens,
 *   and a line break is kept where the comment acted as one (ASI stays intact).
 * - A leading byte-order mark is preserved. Reported positions index into the
 *   `source` string exactly as `scanComments(source)` reports them (a BOM
 *   counts as its first character).
 * - The result is re-scanned; if the remaining comments do not match the kept
 *   set, an error is thrown instead of returning corrupted output.
 */
export function removeComments(source: string, options: RemoveOptions = {}): RemoveResult {
  const jsx = options.jsx === true;
  const comments = scanComments(source, { jsx });

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

  for (;;) {
    removed = shieldNextLineDirectives(source, removed, kept, skipped);

    if (removed.length === 0) {
      return { code: source, removed, kept, skipped, changed: false };
    }

    const code = spliceKeepingBom(source, removed);
    const survivor = firstChangedSurvivor(source, code, scanComments(code, { jsx }), kept, skipped);
    if (survivor === undefined) {
      return { code, removed, kept, skipped, changed: true };
    }

    // A surviving comment changed meaning: with everything before it deleted
    // it became the file's first comment (or its very first bytes), turning a
    // previously inert positional directive live. Re-protect the removal
    // candidate closest before it and try again: that comment then keeps
    // holding the survivor away from the activating position, exactly as the
    // input did. (Looping, because the re-protected comment can itself be a
    // next-line directive that shields further lines.)
    const blocker = closestRemovalBefore(removed, survivor);
    if (blocker === undefined) {
      throw unexpectedResult();
    }
    removed = removed.filter((comment) => comment !== blocker);
    kept.push(blocker);
    kept.sort((a, b) => a.start - b.start);
  }
}

function unexpectedResult(): Error {
  return new Error("comment removal produced an unexpected result; refusing to continue");
}

/**
 * Compares the spliced output's comments against the comments meant to
 * survive, in document order (removal never reorders them). Throws when the
 * texts themselves differ (the output would be corrupted) and returns the
 * first surviving comment whose directive semantics changed, or undefined
 * when the output is exactly as expected. Besides the canonical directive
 * name, the position-dependent pragmas are compared on their own: a comment
 * can carry an inert `@format` underneath the directive an earlier rule
 * already named (an eslint config block, say), and that pragma going live
 * must not hide behind the unchanged name.
 */
function firstChangedSurvivor(
  source: string,
  code: string,
  actual: Comment[],
  kept: Comment[],
  skipped: Comment[],
): Comment | undefined {
  const expected = [...kept, ...skipped].sort((a, b) => a.start - b.start);
  if (actual.length !== expected.length) {
    throw unexpectedResult();
  }
  for (const [index, comment] of expected.entries()) {
    const survivor = actual[index] as Comment;
    if (survivor.text !== comment.text) {
      throw unexpectedResult();
    }
    if (survivor.directive !== comment.directive) return comment;
    const before = activePositionalDirectives(comment.kind, comment.text, positionalPlacement(source, comment));
    const after = activePositionalDirectives(survivor.kind, survivor.text, positionalPlacement(code, survivor));
    if (before.join("\n") !== after.join("\n")) return comment;
  }
  return undefined;
}

/**
 * The placement bits the position-dependent directives care about, derived
 * without a parse: the comment is the file's first comment when nothing but
 * whitespace (or a shebang) precedes it — any earlier comment's text keeps
 * the slice non-blank — and it sits at the file start when it begins at
 * offset zero. Header status needs the token structure, but removing
 * comments never moves a comment across the first token, so the positional
 * check does not consult it.
 */
function positionalPlacement(text: string, comment: Comment): DirectivePlacement {
  const shebangLength = /^#!.*/.exec(text)?.[0].length ?? 0;
  return {
    header: false,
    firstComment: isBlank(text.slice(shebangLength, comment.start)),
    fileStart: comment.start === 0,
  };
}

/** The removal candidate that starts closest before the comment, if any. */
function closestRemovalBefore(removals: readonly Comment[], comment: Comment): Comment | undefined {
  let closest: Comment | undefined;
  for (const removal of removals) {
    if (removal.start < comment.start) closest = removal;
  }
  return closest;
}

/**
 * Splices the removals out of the source, restoring the byte-order mark when
 * dropping a comment-only first line took it along: the mark is an encoding
 * artifact, not line content.
 */
function spliceKeepingBom(source: string, removals: readonly Comment[]): string {
  if (!source.startsWith("\uFEFF")) return splice(source, removals);
  // The splicing itself works on the BOM-less body (with ranges shifted to
  // match) so its line handling never sees the mark, then the mark is
  // re-attached; this keeps `\uFEFF// gone\n...` from losing the mark with
  // the dropped line.
  const body = source.slice(1);
  const shifted = removals.map((comment) => ({ ...comment, start: comment.start - 1, end: comment.end - 1 }));
  return `\uFEFF${splice(body, shifted)}`;
}

function isProtected(comment: Comment, options: RemoveOptions): boolean {
  if (comment.directive !== undefined && options.removeDirectives !== true) return true;
  if (isLegalComment(comment.text) && options.removeLegal !== true) return true;
  return false;
}

/**
 * Re-protects comments whose removal would delete a physical line sitting
 * under a surviving next-line directive (`@ts-expect-error`,
 * `eslint-disable-next-line`, ...). Dropping such a line would shift the
 * following code up, silently changing which line the directive applies to —
 * and with it the compiler or linter behaviour.
 *
 * The check works on whole lines, not single comments: a line holding several
 * removable comments (`/* one *​/ /* two *​/`) vanishes just the same, so every
 * comment on it has to stay. Runs to a fixpoint because a re-protected
 * comment can itself be a next-line directive shielding further lines (when
 * directives are being removed selectively).
 */
function shieldNextLineDirectives(source: string, removed: Comment[], kept: Comment[], skipped: Comment[]): Comment[] {
  const lineOffsets = lineStartOffsets(source);
  const totalLines = lineOffsets.length;
  const shieldedLines = new Set<number>();
  const processed = new Set<Comment>();
  let stillRemoved = removed;

  const collectShields = (): boolean => {
    let added = false;
    for (const comment of [...kept, ...skipped]) {
      if (processed.has(comment)) continue;
      processed.add(comment);
      if (comment.directive === undefined || !isNextLineDirective(comment.directive)) continue;
      // A trailing formatter or scanner suppression (`a = [1]; // oxfmt-ignore`,
      // `secret(); // nosemgrep`) targets its own line, so it shields nothing
      // below it.
      if (TRAILING_TARGETS_OWN_LINE.has(comment.directive) && !occupiesWholeLines(source, comment)) {
        continue;
      }
      // Counted pragmas like `c8 ignore next 3` cover several lines.
      for (let offset = 1; offset <= shieldedLineCount(comment); offset += 1) {
        const line = comment.endLine + offset;
        if (line > totalLines) break;
        if (!shieldedLines.has(line)) {
          shieldedLines.add(line);
          added = true;
        }
      }
    }
    return added;
  };

  const protectShieldedLines = (): boolean => {
    let changed = false;
    for (const line of shieldedLines) {
      const group = vanishingLineGroup(source, line, lineOffsets, stillRemoved);
      if (group === undefined) continue;
      const grouped = new Set(group);
      stillRemoved = stillRemoved.filter((comment) => !grouped.has(comment));
      kept.push(...group);
      changed = true;
    }
    return changed;
  };

  collectShields();
  while (protectShieldedLines()) {
    if (!collectShields()) break;
  }
  if (stillRemoved.length !== removed.length) {
    kept.sort((a, b) => a.start - b.start);
  }
  return stillRemoved;
}

/**
 * The removal candidates that would make the given line disappear: every
 * non-whitespace character of the line lies inside one of them, so splicing
 * them out deletes the physical line. Returns undefined when the line
 * survives (it holds code, a kept comment, or nothing to remove at all).
 */
function vanishingLineGroup(
  source: string,
  line: number,
  lineOffsets: readonly number[],
  removals: readonly Comment[],
): Comment[] | undefined {
  // collectShields never shields a line beyond the last one, so the offset exists.
  const lineStart = lineOffsets[line - 1] as number;
  const lineEnd = lineOffsets[line] ?? source.length;
  const group = removals.filter((comment) => comment.start < lineEnd && comment.end > lineStart);
  if (group.length === 0) return undefined;
  for (let index = lineStart; index < lineEnd; index += 1) {
    if (isBlank(source[index] as string)) continue;
    if (!group.some((comment) => comment.start <= index && index < comment.end)) return undefined;
  }
  return group;
}

/** Start offset of every line, numbered the way the scanner numbers them. */
function lineStartOffsets(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] as string;
    if (char === "\r") {
      starts.push(source[index + 1] === "\n" ? (index += 1) + 1 : index + 1);
    } else if (char === "\n" || char === "\u2028" || char === "\u2029") {
      starts.push(index + 1);
    }
  }
  return starts;
}

// These suppressions only apply to the following node/line when they stand on
// their own line — trailing after code they target (at most) their own line.
// Other next-line directives (`@ts-ignore`, `no-dd-sa`, ...) target the next
// line even when they trail code.
const TRAILING_TARGETS_OWN_LINE = new Set([
  "prettier-ignore",
  "oxfmt-ignore",
  "dprint-ignore",
  "lgtm",
  "codeql",
  "skipcq",
  "nosemgrep",
]);

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
      "dprint-ignore",
      "rome-ignore",
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
      // Directives that hang off the node or line directly below them: a
      // whole-line comment between them and their target would change what
      // they apply to, so the line below stays shielded.
      "ts-prune-ignore-next",
      "million-ignore",
      "@million-skip",
      "@million-jsx-skip",
      "@deno-types",
      "@ts-types",
      "deepcode-ignore",
      "skipcq",
      "lgtm",
      "codeql",
      "nosemgrep",
      "no-dd-sa",
      "datadog-disable",
      "noinspection",
      "language-injection",
      "@next-codemod-error",
      "@next-codemod-ignore",
      "$FlowFixMe",
      "$FlowExpectedError",
      "$FlowIssue",
      "$FlowIgnore",
      "pragma-allowlist-nextline-secret",
      "cspell:disable-next",
      "GraphQL",
      "HTML",
    ].includes(name)
  );
}

// The coverage pragmas that actually parse a line count after `ignore next`
// (c8 / v8-to-istanbul, Vitest's ast-v8-to-istanbul, and Node's test-runner
// coverage). Everything else — `@ts-expect-error`, `eslint-disable-next-line`
// and friends — covers exactly one line, no matter what prose like
// "we ignore next 3 legacy calls" appears in the reason text.
const COUNTED_NEXT_LINE = new Set(["istanbul-ignore-next", "c8-ignore-next", "v8-ignore-next", "node:coverage-ignore"]);

/** Number of following lines a next-line pragma covers (`c8 ignore next 3` → 3). */
function shieldedLineCount(comment: Comment): number {
  if (comment.directive === undefined || !COUNTED_NEXT_LINE.has(comment.directive)) return 1;
  const match = /\bignore\s+next\s+(\d+)\b/.exec(comment.text);
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

// Every ECMAScript line break the way the scanner counts them: CRLF as one
// break, then lone LF / CR and the U+2028/U+2029 separators.
const NEXT_LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/g;

/** End offset (exclusive) of the last line break in the chunk, or -1 when it has none. */
function lastLineBreakEnd(chunk: string): number {
  for (let index = chunk.length - 1; index >= 0; index -= 1) {
    if (LINE_TERMINATOR.test(chunk[index] as string)) return index + 1;
  }
  return -1;
}

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
    const breakEnd = lastLineBreakEnd(chunk);
    lineIsBlank = breakEnd === -1 ? lineIsBlank && isBlank(chunk) : isBlank(chunk.slice(breakEnd));
    lastChar = chunk.slice(-1);
  };

  /** Deletes everything the output holds after its last line break. */
  const dropCurrentLine = (): void => {
    while (segments.length > 0) {
      const last = segments[segments.length - 1] as string;
      const breakEnd = lastLineBreakEnd(last);
      if (breakEnd === -1) {
        segments.pop();
        continue;
      }
      segments[segments.length - 1] = last.slice(0, breakEnd);
      lineIsBlank = true;
      lastChar = last.charAt(breakEnd - 1);
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

    NEXT_LINE_BREAK.lastIndex = cursor;
    const lineBreak = NEXT_LINE_BREAK.exec(source);
    const contentEnd = lineBreak === null ? source.length : lineBreak.index;
    const lineEnd = lineBreak === null ? source.length : lineBreak.index + lineBreak[0].length;
    const restContent = source.slice(cursor, contentEnd);

    if (lineIsBlank && isBlank(restContent)) {
      // The comment occupied whole line(s): drop them entirely.
      dropCurrentLine();
      cursor = lineEnd;
    } else if (isBlank(restContent)) {
      // Trailing comment after code: trim the gap, keep the line break.
      trimLineEnd();
      push(source.slice(contentEnd, lineEnd));
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
