import { firstIndexAtOrAfter, type Range } from "./ranges.js";

/**
 * Line handling shared by the scanner's consumers. Unless given another line
 * break, everything here counts lines the way the TypeScript scanner does:
 * LF, CR, U+2028 and U+2029 each end a line, and CRLF is a single break.
 */

/** Matches one ECMAScript line terminator character. */
export const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

/** Matches one line break: CRLF as a unit, else any single terminator. */
export const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;

/** True when the text holds nothing but whitespace (a byte-order mark included). */
export function isBlank(text: string): boolean {
  return /^\s*$/.test(text);
}

/** True for a space or a tab, the blanks that hold the tokens on a line apart. */
export function isHorizontalSpace(char: string | undefined): boolean {
  return char === " " || char === "\t";
}

/** Splits on every line break, so exotic terminators never leak into single-line output. */
export function splitLines(text: string): string[] {
  return text.split(LINE_BREAK);
}

/** The literal last line of the text, exactly as tsc slices a block comment's closing line. */
export function lastLine(text: string): string {
  const lines = splitLines(text);
  return lines[lines.length - 1] as string;
}

/**
 * Start offset of every line, numbered the way the scanner numbers them
 * (line 1 starts at index 0) — or, given another `lineBreak`, the way that
 * pattern breaks lines.
 */
export function lineStartOffsets(source: string, lineBreak: RegExp = LINE_BREAK): number[] {
  const starts = [0];
  for (const match of source.matchAll(new RegExp(lineBreak, "g"))) {
    starts.push(match.index + match[0].length);
  }
  return starts;
}

/** Index of the line holding the offset, given every line's start offset (see lineStartOffsets). */
export function lineIndexAt(lineStarts: readonly number[], offset: number): number {
  return firstIndexAtOrAfter(lineStarts, offset + 1, (start) => start) - 1;
}

/**
 * True when nothing but whitespace shares the range's first and last lines.
 * Lines are delimited by any ECMAScript line terminator, matching how the
 * scanner numbers them (a lone `\r`, U+2028 and U+2029 count too).
 */
export function occupiesWholeLines(source: string, range: Range): boolean {
  return opensItsLine(source, range) && closesItsLine(source, range);
}

/** True when nothing but whitespace follows the range on its last line. */
export function closesItsLine(source: string, range: Range): boolean {
  return blankToLineEdge(source, range.end, 1);
}

/** True when nothing but whitespace precedes the range on its first line. */
export function opensItsLine(source: string, range: Range): boolean {
  return blankToLineEdge(source, range.start - 1, -1);
}

/**
 * True when nothing but whitespace lies from the offset on, in the direction
 * of `step`, up to the line break or the edge of the source.
 */
function blankToLineEdge(source: string, from: number, step: 1 | -1): boolean {
  for (let index = from; index >= 0 && index < source.length; index += step) {
    const char = source[index] as string;
    if (LINE_TERMINATOR.test(char)) return true;
    if (!isBlank(char)) return false;
  }
  return true;
}
