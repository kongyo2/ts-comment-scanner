import { LINE_BREAK, LINE_TERMINATOR, isBlank, isHorizontalSpace, lineIndexAt, lineStartOffsets } from "./lines.js";
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
  /**
   * An empty line takes the deleted range's place, instead of its lines
   * vanishing or joining what surrounds them: what precedes the range on its
   * first line ends there, and what follows it on its last line starts below
   * the empty line.
   */
  blankLine?: boolean;
}

/**
 * The lines (1-based, numbered as lineStartOffsets numbers them) that
 * deleting ranges has to leave in place, each a line of its own, because a
 * directive that stays covers them.
 */
export interface ShieldedLines {
  /**
   * The lines a directive covers. None is joined to another: with code on
   * both sides of a deleted range that spans lines, one of them shielded, a
   * line break of the range stays between them, wherever the range stands.
   */
  shielded: ReadonlySet<number>;
  /**
   * Those of them the deletions empty that still have something below them
   * (see heldLines). Each stays, as an empty line, so that what is below it
   * moves up no line.
   */
  held: ReadonlySet<number>;
}

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

// Every line break of a text, CRLF as one.
const ALL_LINE_BREAKS = new RegExp(LINE_BREAK.source, "g");

/**
 * The `count` line breaks that stay of those a deletion could take along —
 * the ones inside the deleted range, and the ones around the lines it
 * empties. Those ending in a line feed stay first: they end a line for
 * every tool, where a lone CR, U+2028 or U+2029 ends one for tsc and ESLint
 * but none for the tools that only count line feeds (tree-sitter, oxlint,
 * Semgrep, c8), so the code on both sides stays on rows apart wherever a
 * line feed held it apart. They stay in the order the source has them.
 */
function stayingBreaks(breaks: readonly string[], count: number): string[] {
  const staying = new Set<number>();
  for (const lineFeed of [true, false]) {
    for (const [index, lineBreak] of breaks.entries()) {
      if (staying.size < count && lineBreak.endsWith("\n") === lineFeed) staying.add(index);
    }
  }
  return breaks.filter((_, index) => staying.has(index));
}

const NO_SHIELDED_LINES: ShieldedLines = { shielded: new Set(), held: new Set() };

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
 * deleted ranges and leaving the shielded lines in place. Output is
 * accumulated as segments with incremental line-state tracking, so the work
 * stays linear in the source size even for comment-dense files.
 *
 * A deleted range takes line breaks along: its own, and where it empties
 * lines, the ones around them. As many of them stay as there are lines left
 * to end — the line of the code before the range, a line break that kept two
 * tokens apart, the held lines — and which ones is stayingBreaks' choice.
 */
export function applyEdits(source: string, edits: readonly Edit[], lines: ShieldedLines = NO_SHIELDED_LINES): string {
  const segments: string[] = [];
  let cursor = 0;
  const lineStarts = lines.shielded.size > 0 ? lineStartOffsets(source) : [];
  /** The (1-based) line holding the offset; 0 where no line is shielded. */
  const lineOf = (offset: number): number => (lineStarts.length === 0 ? 0 : lineIndexAt(lineStarts, offset) + 1);
  /** How many of the lines `from` to `to` (inclusive) are held. */
  const heldAmong = (from: number, to: number): number => {
    let held = 0;
    for (let line = from; line <= to; line += 1) {
      if (lines.held.has(line)) held += 1;
    }
    return held;
  };
  /** Whether the output's current (unterminated) line is all whitespace so far. */
  let lineIsBlank = true;
  /** Last character of the output so far ("" while empty). */
  let lastChar = "";

  /** The character the output ends in ("" while empty), read off the segments where some were taken off its end. */
  const outputEnd = (): string => segments.at(-1)?.slice(-1) ?? "";

  /** Appends the chunk as it is. */
  const append = (chunk: string): void => {
    if (chunk === "") return;
    segments.push(chunk);
    const breakEnd = lastLineBreakEnd(chunk);
    lineIsBlank = breakEnd === -1 ? lineIsBlank && isBlank(chunk) : isBlank(chunk.slice(breakEnd));
    lastChar = chunk.slice(-1);
  };

  /**
   * Appends the chunk, keeping the line breaks on both sides of the seam
   * apart: a lone CR that a deletion leaves right in front of a line feed
   * would read as one CRLF with it, a line break short, so the line feeds
   * go in front of the CRs the output ends in.
   */
  const push = (chunk: string): void => {
    let loneReturns = "";
    while (lastChar === "\r" && chunk.startsWith("\n")) {
      const last = segments.pop() as string;
      if (last.length > 1) segments.push(last.slice(0, -1));
      lastChar = outputEnd();
      loneReturns += "\r";
    }
    const rest = loneReturns === "" ? chunk : chunk.replace(/^\n+/, "");
    append(chunk.slice(0, chunk.length - rest.length) + loneReturns + rest);
  };

  /** Takes everything the output holds after its last line break out of it, and returns it. */
  const takeCurrentLine = (): string => {
    let taken = "";
    while (segments.length > 0) {
      const last = segments[segments.length - 1] as string;
      const breakEnd = lastLineBreakEnd(last);
      taken = last.slice(breakEnd === -1 ? 0 : breakEnd) + taken;
      if (breakEnd !== -1) {
        segments[segments.length - 1] = last.slice(0, breakEnd);
        break;
      }
      segments.pop();
    }
    lineIsBlank = true;
    lastChar = outputEnd();
    return taken;
  };

  /**
   * Takes the line break the output ends in out of it, and returns it — none
   * at the start of the output. Only called right after takeCurrentLine, and
   * followed by a line break going back in, which sets the line state again.
   */
  const takeBreak = (): string[] => {
    const last = segments.pop();
    if (last === undefined) return [];
    const lineBreak = last.endsWith("\r\n") ? "\r\n" : last.slice(-1);
    const rest = last.slice(0, -lineBreak.length);
    if (rest !== "") segments.push(rest);
    lastChar = outputEnd();
    return [lineBreak];
  };

  /** Puts `count` of the line breaks back in (see stayingBreaks). */
  const keep = (breaks: readonly string[], count: number): void => {
    for (const lineBreak of stayingBreaks(breaks, count)) push(lineBreak);
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

    if (edit.blankLine === true) {
      // Both line breaks around the empty line end in a line feed, which tsc
      // and dprint alike count, so after a lone CR, U+2028 or U+2029 one more
      // goes in.
      const lineFeed = source.slice(edit.start, lineEnd).includes("\r\n") ? "\r\n" : "\n";
      if (lineIsBlank) {
        takeCurrentLine();
        if (lastChar !== "\n") append(lineFeed);
      } else {
        trimLineEnd();
        append(lineFeed);
      }
      append(lineFeed);
      cursor = isBlank(restContent) ? lineEnd : skipSpaces(cursor);
      continue;
    }

    // The line breaks the range holds, the one after its last line, and the
    // lines it starts and ends on.
    const own: readonly string[] = deleted.match(ALL_LINE_BREAKS) ?? [];
    const after = lineBreak === null ? [] : [lineBreak[0]];
    const first = lineOf(edit.start);
    const last = lineOf(Math.max(edit.start, edit.end - 1));

    if (lineIsBlank && isBlank(restContent)) {
      // The range occupied whole line(s): they go, with their line breaks,
      // but for the held ones, which stay as empty lines. One line break
      // still ends the line in front of them.
      takeCurrentLine();
      const before = takeBreak();
      keep([...before, ...own, ...after], before.length + heldAmong(first, last));
      cursor = lineEnd;
    } else if (isBlank(restContent)) {
      // Trailing after code: trim the gap; one line break ends the code's
      // line. The lines the range empties below the code go, but for the
      // held ones.
      trimLineEnd();
      keep([...own, ...after], after.length + heldAmong(first + 1, last));
      cursor = lineEnd;
    } else if (
      !lineIsBlank &&
      own.length > 0 &&
      (isApart(first, last) || needsSpace(lastChar, source.charAt(cursor)))
    ) {
      // Code on both sides of a range that spans lines. Per ECMA-262 a
      // multi-line comment acts as a line terminator for semicolon
      // insertion, so one of its line breaks takes its place instead of
      // merging the lines. (Right after an opening bracket or before closing
      // punctuation a line terminator changes nothing, so a multi-line
      // comment there goes without one.) Where one of the two lines is
      // shielded, a line break stays between them wherever the range stands,
      // and the held lines between them stay as well.
      trimLineEnd();
      keep(own, heldAmong(first + 1, last - 1) + 1);
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
      // whitespace after it collapses into that. Where the range opened its
      // line, the lines it empties above the code after it go, but for the
      // held ones, and one line break still ends the line in front of them.
      if (lineIsBlank && own.length > 0) {
        const indentation = takeCurrentLine();
        const before = takeBreak();
        keep([...before, ...own], before.length + heldAmong(first, last - 1));
        push(indentation);
      }
      cursor = skipSpaces(cursor);
      if (edit.jsx !== true && !lineIsBlank && CLOSING_PUNCTUATION.includes(source.charAt(cursor))) {
        // `a /* x *​/)` — the space before only held the comment off the code.
        trimLineEnd();
      }
    }
  }

  segments.push(source.slice(cursor));
  return segments.join("");

  /** Whether the lines a range starts and ends on have to stay apart: one is shielded, or held lines lie between. */
  function isApart(first: number, last: number): boolean {
    return lines.shielded.has(first) || lines.shielded.has(last) || heldAmong(first + 1, last - 1) > 0;
  }
}

/** Where blocks open and close besides brackets: JSX tags, whose children are laid out like a block's. */
export interface BlockTags {
  /** Offsets just past every opening tag. */
  openingTagEnds: ReadonlySet<number>;
  /** Offsets of every closing tag. */
  closingTagStarts: ReadonlySet<number>;
}

type LineKind = "vanishing" | "blank" | "code";

/** Start offset and kind of every line of the source, a final line break ending the last line. */
interface LineKinds {
  offsets: number[];
  kinds: LineKind[];
}

/**
 * What becomes of each line once the (sorted) `deletions` are made: a line
 * vanishes when every non-whitespace character on it is deleted; a blank
 * line holds nothing but spaces and tabs (a lone vertical tab or no-break
 * space is content to tsc 7) and lies outside every comment; any other line
 * holds code.
 */
function lineKinds(source: string, deletions: readonly Range[], comments: readonly Range[]): LineKinds {
  const offsets = lineStartOffsets(source);
  // A final line break ends the last line rather than opening an empty one.
  const lineCount =
    offsets.length > 1 && offsets[offsets.length - 1] === source.length ? offsets.length - 1 : offsets.length;
  const kinds: LineKind[] = [];
  for (let line = 0; line < lineCount; line += 1) {
    const start = offsets[line] as number;
    const end = offsets[line + 1] ?? source.length;
    kinds.push(lineKind(source, start, end, endOfContent(source, start, end), deletions, comments));
  }
  return { offsets, kinds };
}

/**
 * The shielded lines (1-based) that the deletions empty and that still have
 * code, or a comment that stays, somewhere below them. Dropping such a line
 * would move what is below it up into the directive's reach, so it stays, as
 * an empty line (see ShieldedLines.held); below the last line that keeps
 * anything there is nothing to move.
 */
export function heldLines(
  source: string,
  deletions: readonly Range[],
  comments: readonly Range[],
  shieldedLines: ReadonlySet<number>,
): Set<number> {
  const held = new Set<number>();
  if (shieldedLines.size === 0) return held;
  const { kinds } = lineKinds(source, deletions, comments);
  const lastKept = kinds.lastIndexOf("code");
  for (const line of shieldedLines) {
    if (line <= lastKept && kinds[line - 1] === "vanishing") held.add(line);
  }
  return held;
}

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
 * `deletions` are the ranges about to be deleted, sorted. `shieldedLines`
 * are the lines a surviving directive reaches (1-based): the blank lines
 * among them stay, so no code moves into the directive's reach, and so do
 * the `held` ones, which the deletions leave empty (see heldLines) — a held
 * line counts among the blank lines its run is trimmed to.
 */
export function blankLineEdits(
  source: string,
  deletions: readonly Range[],
  comments: readonly Range[],
  { shielded, held }: ShieldedLines,
  tags: BlockTags,
): Edit[] {
  const { offsets, kinds } = lineKinds(source, deletions, comments);
  const lineCount = kinds.length;
  const lineStart = (line: number): number => offsets[line] as number;
  const lineContentEnd = (line: number): number =>
    endOfContent(source, lineStart(line), offsets[line + 1] ?? source.length);

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
    // The lines of the run that are blank once the deletions are made.
    const blanks: number[] = [];
    // Blank lines between consecutive vanishing lines, from before the first to after the last.
    const gaps = [0];
    for (; line < lineCount && kinds[line] !== "code"; line += 1) {
      if (kinds[line] === "vanishing") {
        gaps.push(0);
        if (held.has(line + 1)) blanks.push(line);
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
      if (shielded.has(blank + 1)) keep = Math.max(keep, position + 1);
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
