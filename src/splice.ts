import { LINE_BREAK, LINE_TERMINATOR, isBlank, lineStartOffsets } from "./lines.js";
import { firstIndexAtOrAfter, rangeAt, type Range } from "./ranges.js";

/** One change to the source: a range to delete (tidying its line) or to replace verbatim. */
export interface Edit extends Range {
  /** Text put in place of the range as is; without it the range is deleted and its line tidied. */
  replacement?: string;
  /**
   * The range is a JSX expression container. Nothing is ever inserted in
   * its place — not even a space to keep its neighbours apart — because
   * those neighbours are JSX text and tags, not tokens.
   */
  jsx?: boolean;
}

const isHorizontalSpace = (char: string | undefined): boolean => char === " " || char === "\t";

// Brackets never merge with what follows them, nor punctuation with what
// precedes it, so removing a comment between them needs no space to keep
// the tokens apart, and the whitespace that only held the comment off them
// can go: `f(/* a *​/ x)` becomes `f(x)` and `{/* empty *​/}` becomes `{}`.
const OPENING_BRACKETS = "([{";
const CLOSING_PUNCTUATION = ")]},;";

/** Whether `before` and `after`, about to meet where a comment was, need a space between them. */
function needsSpace(before: string, after: string): boolean {
  return !OPENING_BRACKETS.includes(before) && !CLOSING_PUNCTUATION.includes(after);
}

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
 * Applies sorted, non-overlapping edits to the source, tidying the lines of
 * deleted ranges. Output is accumulated as segments with incremental
 * line-state tracking, so the work stays linear in the source size even for
 * comment-dense files.
 */
export function applyEdits(source: string, edits: readonly Edit[]): string {
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

  /**
   * Deletes everything the output holds after its last line break, and that
   * break too when `takeBreak` asks for it and the break holds no line feed;
   * returns whether it went.
   */
  const dropCurrentLine = (takeBreak: boolean): boolean => {
    while (segments.length > 0) {
      const last = segments[segments.length - 1] as string;
      const breakEnd = lastLineBreakEnd(last);
      if (breakEnd === -1) {
        segments.pop();
        continue;
      }
      const tookBreak = takeBreak && last.charAt(breakEnd - 1) !== "\n";
      segments[segments.length - 1] = last.slice(0, tookBreak ? breakEnd - 1 : breakEnd);
      lineIsBlank = !tookBreak;
      lastChar = last.charAt(breakEnd - (tookBreak ? 2 : 1));
      return tookBreak;
    }
    lineIsBlank = true;
    lastChar = "";
    return false;
  };

  /**
   * Deletes trailing spaces/tabs of the output's current line. Only called
   * while that line holds code, which the trimming stops at.
   */
  const trimLineEnd = (): void => {
    for (;;) {
      const last = segments[segments.length - 1] as string;
      let end = last.length;
      while (end > 0 && isHorizontalSpace(last[end - 1])) end -= 1;
      if (end > 0) {
        segments[segments.length - 1] = last.slice(0, end);
        lastChar = last.charAt(end - 1);
        return;
      }
      segments.pop();
    }
  };

  /** Offset of the first character at or after `from` that is not a space or tab. */
  const skipSpaces = (from: number): number => {
    let index = from;
    while (isHorizontalSpace(source[index])) index += 1;
    return index;
  };

  for (const edit of edits) {
    push(source.slice(cursor, edit.start));
    cursor = edit.end;
    if (edit.replacement !== undefined) {
      push(edit.replacement);
      continue;
    }

    NEXT_LINE_BREAK.lastIndex = cursor;
    const lineBreak = NEXT_LINE_BREAK.exec(source);
    const contentEnd = lineBreak === null ? source.length : lineBreak.index;
    const lineEnd = lineBreak === null ? source.length : lineBreak.index + lineBreak[0].length;
    const restContent = source.slice(cursor, contentEnd);
    const deleted = source.slice(edit.start, edit.end);

    if (lineIsBlank && isBlank(restContent)) {
      // The range occupied whole line(s): drop them entirely, with the
      // break that ends them — or, when that one is a line feed and the
      // break in front of them is not, with that one instead. tree-sitter
      // (and so ast-grep) starts a row at a line feed alone, so the rows
      // around the dropped lines stay apart, while tsc sees one break either
      // way.
      cursor = dropCurrentLine(lineBreak?.[0].endsWith("\n") === true) ? contentEnd : lineEnd;
    } else if (isBlank(restContent)) {
      // Trailing after code: trim the gap, keep the line break.
      trimLineEnd();
      push(source.slice(contentEnd, lineEnd));
      cursor = lineEnd;
    } else if (!lineIsBlank && LINE_TERMINATOR.test(deleted) && needsSpace(lastChar, source.charAt(cursor))) {
      // Code on both sides of a range that spans lines. Per ECMA-262 a
      // multi-line comment acts as a line terminator for semicolon
      // insertion, so a real line break (matching the file's style) takes
      // its place instead of merging the lines. (Right after an opening
      // bracket or before closing punctuation a line terminator changes
      // nothing, so a multi-line comment there goes without one.)
      trimLineEnd();
      push(deleted.includes("\r\n") ? "\r\n" : "\n");
    } else if (lastChar !== "" && !isBlank(lastChar)) {
      // Code right before the range, more on the same line after it.
      if (edit.jsx === true) continue;
      const next = source.charAt(cursor);
      if (!isBlank(next)) {
        // `a/* x *​/b` would merge tokens: keep them apart.
        if (needsSpace(lastChar, next)) push(" ");
      } else if (OPENING_BRACKETS.includes(lastChar)) {
        // `(/* x *​/ a` — the space only held the comment off the code.
        cursor = skipSpaces(cursor);
      }
    } else {
      // Whitespace (or the line start) right before the range: the
      // whitespace after it collapses into that.
      cursor = skipSpaces(cursor);
      if (edit.jsx !== true && !lineIsBlank && CLOSING_PUNCTUATION.includes(source.charAt(cursor))) {
        // `a /* x *​/)` — the space before only held the comment off the code.
        trimLineEnd();
      }
    }
  }

  segments.push(source.slice(cursor));
  return segments.join("");
}

/** Where blocks open and close besides brackets: JSX tags, whose children are laid out like a block's. */
export interface BlockTags {
  /** Offsets just past every opening tag. */
  openingTagEnds: ReadonlySet<number>;
  /** Offsets of every closing tag. */
  closingTagStarts: ReadonlySet<number>;
}

type LineKind = "vanishing" | "blank" | "code";

/**
 * Deletions of the blank lines that removing whole comment lines would pile
 * up. Where comment-only lines vanish, the blank lines around them close
 * ranks: two paragraphs that a comment stood between, each separated from it
 * by a blank line, end up separated by two. Every run of blank and vanishing
 * lines is therefore trimmed to as many blank lines as the widest gap it
 * held — never more than the source had in one place, never fewer than it
 * had on either side — except at the start or end of the file, or of a
 * block (an opening bracket ending the line before, a closing one starting
 * the line after, or JSX tags), where only the blank lines that already sat
 * against that edge stay: the ones on the far side of the comment merely
 * separated the comment from the code.
 *
 * `deletions` are the ranges about to be deleted, sorted; a line vanishes
 * when every non-whitespace character on it is deleted. Blank lines hold
 * nothing but spaces and tabs (a lone vertical tab or no-break space is
 * content to tsc 7) and lie outside every comment. `shieldedLines` are
 * lines a surviving next-line directive reaches (1-based): the blank lines
 * among them stay, so no code moves into the directive's reach.
 */
export function blankLineEdits(
  source: string,
  deletions: readonly Range[],
  comments: readonly Range[],
  shieldedLines: ReadonlySet<number>,
  tags: BlockTags,
): Edit[] {
  const offsets = lineStartOffsets(source);
  // A final line break ends the last line rather than opening an empty one.
  const lineCount =
    offsets.length > 1 && offsets[offsets.length - 1] === source.length ? offsets.length - 1 : offsets.length;
  const lineStart = (line: number): number => offsets[line] as number;
  const lineContentEnd = (line: number): number =>
    endOfContent(source, lineStart(line), offsets[line + 1] ?? source.length);

  const kinds: LineKind[] = [];
  for (let line = 0; line < lineCount; line += 1) {
    kinds.push(
      lineKind(source, lineStart(line), offsets[line + 1] ?? source.length, lineContentEnd(line), deletions, comments),
    );
  }

  /** Offset of the first (or last) character on the line that survives the deletions and is not whitespace. */
  const survivingEdge = (line: number, fromEnd: boolean): number | undefined => {
    const start = lineStart(line);
    const end = lineContentEnd(line);
    for (let step = 0; step < end - start; step += 1) {
      const index = fromEnd ? end - 1 - step : start + step;
      if (!isBlank(source[index] as string) && rangeAt(deletions, index) === undefined) return index;
    }
    return undefined;
  };
  const opensBlock = (line: number): boolean => {
    const index = survivingEdge(line, true);
    return (
      index !== undefined &&
      rangeAt(comments, index) === undefined &&
      (OPENING_BRACKETS.includes(source[index] as string) || tags.openingTagEnds.has(index + 1))
    );
  };
  // (A line's first surviving character is never inside a comment unless it
  // is the comment's opening slash, so no comment check is needed here.)
  const closesBlock = (line: number): boolean => {
    const index = survivingEdge(line, false);
    return index !== undefined && (")]}".includes(source[index] as string) || tags.closingTagStarts.has(index));
  };

  const edits: Edit[] = [];
  let line = 0;
  while (line < lineCount) {
    if (kinds[line] === "code") {
      line += 1;
      continue;
    }
    const first = line;
    const blanks: number[] = [];
    // Blank lines between consecutive vanishing lines, from before the first to after the last.
    const gaps = [0];
    for (; line < lineCount && kinds[line] !== "code"; line += 1) {
      if (kinds[line] === "vanishing") {
        gaps.push(0);
      } else {
        blanks.push(line);
        gaps[gaps.length - 1] = (gaps[gaps.length - 1] as number) + 1;
      }
    }
    if (gaps.length === 1) continue;

    const leading = gaps[0] as number;
    const trailing = gaps[gaps.length - 1] as number;
    const atStart = first === 0;
    const atEnd = line === lineCount;
    let keep: number;
    if (atStart || atEnd) {
      keep = atEnd ? (atStart ? 0 : trailing) : leading;
    } else {
      const opens = opensBlock(first - 1);
      const closes = closesBlock(line);
      if (opens && closes) keep = Math.min(leading, trailing);
      else if (opens) keep = leading;
      else if (closes) keep = trailing;
      else keep = gaps.reduce((widest, gap) => Math.max(widest, gap));
    }
    for (const [position, blank] of blanks.entries()) {
      if (shieldedLines.has(blank + 1)) keep = Math.max(keep, position + 1);
    }
    for (const blank of blanks.slice(keep)) {
      edits.push({ start: lineStart(blank), end: lineContentEnd(blank) });
    }
  }
  return edits;
}

/** Offset where the line's content ends, before its line break (CRLF counts as one). */
function endOfContent(source: string, start: number, end: number): number {
  if (end - start >= 2 && source[end - 2] === "\r" && source[end - 1] === "\n") return end - 2;
  if (end > start && LINE_TERMINATOR.test(source[end - 1] as string)) return end - 1;
  return end;
}

function lineKind(
  source: string,
  start: number,
  end: number,
  contentEnd: number,
  deletions: readonly Range[],
  comments: readonly Range[],
): LineKind {
  // Sorted, non-overlapping ranges end in ascending order too, so the first
  // one ending past the line start is the only candidate for touching it.
  const touches = (ranges: readonly Range[]): boolean => {
    const range = ranges[firstIndexAtOrAfter(ranges, start + 1, (candidate) => candidate.end)];
    return range !== undefined && range.start < end;
  };
  if (touches(deletions)) {
    let covered = true;
    for (let index = start; index < contentEnd && covered; index += 1) {
      covered = isBlank(source[index] as string) || rangeAt(deletions, index) !== undefined;
    }
    if (covered) return "vanishing";
  }
  return /^[ \t]*$/.test(source.slice(start, contentEnd)) && !touches(comments) ? "blank" : "code";
}
