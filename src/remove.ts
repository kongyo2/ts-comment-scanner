import { activePositionalDirectives, bunMarkerOffset, isLegalComment, type DirectivePlacement } from "./directives.js";
import { LINE_BREAK, LINE_TERMINATOR, isBlank, lineStartOffsets } from "./lines.js";
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
   * comments whose removal would shift code under a next-line directive or
   * that sit between a directive and the code it reaches past them for, and
   * comments whose removal would move a position-dependent directive
   * (prettier's first-comment pragma, Deno's coverage file pragma, Bun's
   * file-start marker) into effect.
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
 *   first comment, Bun's `// @bun` only at the very start or right after a
 *   shebang line), the leading comment is kept instead.
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
    kept.sort(byStart);
  }
}

function unexpectedResult(): Error {
  return new Error("comment removal produced an unexpected result; refusing to continue");
}

/** Sort comparator for document order: comments are ordered by where they start. */
function byStart(a: Comment, b: Comment): number {
  return a.start - b.start;
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
  const expected = [...kept, ...skipped].sort(byStart);
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
 * the slice non-blank — and it sits at the file start when it begins where
 * Bun reads its marker. Header status needs the token structure, but
 * removing comments never moves a comment across the first token, so the
 * positional check does not consult it.
 */
function positionalPlacement(text: string, comment: Comment): DirectivePlacement {
  const shebangLength = /^#!.*/.exec(text)?.[0].length ?? 0;
  return {
    header: false,
    firstComment: isBlank(text.slice(shebangLength, comment.start)),
    fileStart: comment.start === bunMarkerOffset(text),
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
 * and with it the compiler or linter behaviour. Directives whose tools reach
 * further get more: below a tsc suppression the first line each compiler
 * cannot step over stays, and between a directive that only counts as the
 * last comment before its target (`@deno-types`, ...) and that target every
 * comment stays.
 *
 * The line checks work on whole lines, not single comments: a line holding
 * several removable comments (`/* one *​/ /* two *​/`) vanishes just the same,
 * so every comment on it has to stay. Runs to a fixpoint because a
 * re-protected comment can itself be a next-line directive shielding further
 * lines (when directives are being removed selectively).
 */
function shieldNextLineDirectives(source: string, removed: Comment[], kept: Comment[], skipped: Comment[]): Comment[] {
  const lineOffsets = lineStartOffsets(source);
  const totalLines = lineOffsets.length;
  // Where the code after a directive starts does not depend on which comments
  // go, so it is looked up among all of them.
  const allComments = [...removed, ...kept, ...skipped].sort(byStart);
  const shieldedLines = new Set<number>();
  const blockingLines = new Set<number>();
  const shieldedGaps: Array<readonly [number, number]> = [];
  const processed = new Set<Comment>();
  let stillRemoved = removed;

  const collectShields = (): boolean => {
    let added = false;
    for (const comment of [...kept, ...skipped]) {
      if (processed.has(comment)) continue;
      processed.add(comment);
      const directive = comment.directive;
      if (directive === undefined) continue;
      if (LAST_COMMENT_DIRECTIVES.has(directive)) {
        const codeStart = codeStartAfter(source, comment.end, allComments);
        if (codeStart > comment.end) {
          shieldedGaps.push([comment.end, codeStart]);
          added = true;
        }
        continue;
      }
      if (TSC_SUPPRESSIONS.has(directive)) {
        for (const line of firstBlockingLines(source, comment, lineOffsets, allComments)) {
          if (blockingLines.has(line)) continue;
          blockingLines.add(line);
          added = true;
        }
      }
      if (!isNextLineDirective(directive)) continue;
      // A trailing formatter or scanner suppression (`a = [1]; // oxfmt-ignore`,
      // `secret(); // nosemgrep`) targets its own line, so it shields nothing
      // below it.
      if (TRAILING_TARGETS_OWN_LINE.has(directive) && !occupiesWholeLines(source, comment)) {
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

  const protect = (group: readonly Comment[]): void => {
    const grouped = new Set(group);
    stillRemoved = stillRemoved.filter((comment) => !grouped.has(comment));
    kept.push(...group);
  };

  const protectShields = (): boolean => {
    let changed = false;
    for (const line of shieldedLines) {
      const group = vanishingLineGroup(source, line, lineOffsets, stillRemoved);
      if (group === undefined) continue;
      protect(group);
      changed = true;
    }
    for (const line of blockingLines) {
      const group = lineOpeningGroup(source, line, lineOffsets, stillRemoved);
      if (group === undefined) continue;
      protect(group);
      changed = true;
    }
    for (const [from, to] of shieldedGaps) {
      const group = stillRemoved.filter((comment) => comment.start >= from && comment.start < to);
      if (group.length === 0) continue;
      protect(group);
      changed = true;
    }
    return changed;
  };

  collectShields();
  while (protectShields()) {
    if (!collectShields()) break;
  }
  if (stillRemoved.length !== removed.length) {
    kept.sort(byStart);
  }
  return stillRemoved;
}

/**
 * Offset of the first character at or after `from` that is neither
 * whitespace nor inside one of the (sorted, non-overlapping) comments: where
 * the code a directive ending at `from` targets begins, or the source length
 * when only comments follow.
 */
function codeStartAfter(source: string, from: number, comments: readonly Comment[]): number {
  let next = firstIndexAtOrAfter(comments, from, (comment) => comment.start);
  let index = from;
  while (index < source.length) {
    const comment = comments[next];
    if (comment !== undefined && comment.start === index) {
      index = comment.end;
      next += 1;
    } else if (isBlank(source[index] as string)) {
      index += 1;
    } else {
      return index;
    }
  }
  return source.length;
}

/** Index of the first item whose key is at least `value`, by binary search over ascending keys. */
function firstIndexAtOrAfter<T>(items: readonly T[], value: number, key: (item: T) => number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (key(items[middle] as T) < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * For each TypeScript compiler, the first line between a tsc suppression and
 * the code below it that the compiler does not step over, if any. Looking for
 * the line a suppression applies to, a compiler skips the lines it reads as
 * blank or as a `//` comment (see TSC_PASSABLE_LINES); any other line — one
 * opening with a block comment, say — ends the search, leaving the
 * suppression without a target for that compiler. Deleting that line would
 * let the suppression reach the code instead, so it has to stay. The two
 * compilers can stop at different lines: a line holding only a vertical tab
 * stops tsc 7, while tsc 6 searches on to the next line it cannot pass.
 */
function firstBlockingLines(
  source: string,
  comment: Comment,
  lineOffsets: readonly number[],
  comments: readonly Comment[],
): number[] {
  const codeStart = codeStartAfter(source, comment.end, comments);
  if (codeStart >= source.length) return [];
  const codeLine = firstIndexAtOrAfter(lineOffsets, codeStart + 1, (offset) => offset);
  const found: number[] = [];
  for (const passable of TSC_PASSABLE_LINES) {
    for (let line = comment.endLine + 1; line < codeLine; line += 1) {
      if (!passable.test(source.slice(lineOffsets[line - 1], lineOffsets[line]))) {
        found.push(line);
        break;
      }
    }
  }
  return found;
}

/**
 * The removal candidates on the given line when one of them opens it (holds
 * its first non-whitespace character), so that splicing them out would
 * change how the line starts. Returns undefined when a surviving comment
 * opens the line instead, or nothing on it is to be removed.
 */
function lineOpeningGroup(
  source: string,
  line: number,
  lineOffsets: readonly number[],
  removals: readonly Comment[],
): Comment[] | undefined {
  // A blocking line always lies above the code line, so the next offset exists.
  const lineStart = lineOffsets[line - 1] as number;
  const lineEnd = lineOffsets[line] as number;
  const group = removals.filter((comment) => comment.start < lineEnd && comment.end > lineStart);
  let first = lineStart;
  while (first < lineEnd && isBlank(source[first] as string)) first += 1;
  return group.some((comment) => comment.start <= first && first < comment.end) ? group : undefined;
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

// The suppressions tsc looks past blank and `//` lines for (see
// firstBlockingLines). They stay next-line directives as well: Flow, which
// honours them in TypeScript files, applies them to the very next line.
const TSC_SUPPRESSIONS = new Set(["@ts-ignore", "@ts-expect-error"]);

// The lines each compiler steps over on its way up from a diagnostic to a
// suppression, matched against the whole line, line break included. tsc 6
// trims the line and accepts nothing or a `//` comment; tsc 7 accepts only
// spaces and tabs before the line break or the `//`.
const TSC_PASSABLE_LINES = [/^\s*(?:\/\/|$)/, /^[ \t]*(?:[\r\n]|\/\/)/];

// Directives that only count while no other comment sits between them and
// their target: deno_graph reads `@deno-types`/`@ts-types` from the last
// comment before an import, ts-prune and graphql-tag-pluck from the closest
// leading comment, and ESLint's no-fallthrough and default-case from the last
// comment before the next case or the closing brace. Deleting the comments in
// that gap would newly activate such a directive, so the whole gap is
// shielded — trailing comments in front of the code included.
const LAST_COMMENT_DIRECTIVES = new Set([
  "@deno-types",
  "@ts-types",
  "ts-prune-ignore-next",
  "GraphQL",
  "fallthrough",
  "no-default",
]);

// Directives that target the line or node directly below them. File- and
// range-scoped pragmas (`c8 ignore start`, `istanbul ignore file`, ...) are
// absent: they do not target the following line, so they never shield it.
const NEXT_LINE_DIRECTIVES = new Set([
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
  "million-ignore",
  "@million-skip",
  "@million-jsx-skip",
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
  "HTML",
]);

function isNextLineDirective(name: string): boolean {
  return name.endsWith("-next-line") || NEXT_LINE_DIRECTIVES.has(name);
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

const isHorizontalSpace = (char: string | undefined): boolean => char === " " || char === "\t";

// A global copy of the line-break matcher, so exec() can resume from a removal's end offset.
const NEXT_LINE_BREAK = new RegExp(LINE_BREAK.source, "g");

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
