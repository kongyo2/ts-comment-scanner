/**
 * Line handling shared by the scanner's consumers. Everything here counts
 * lines the way the TypeScript scanner does: LF, CR, U+2028 and U+2029 each
 * end a line, and CRLF is a single break.
 */

/** Matches one ECMAScript line terminator character. */
export const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

/** Matches one line break: CRLF as a unit, else any single terminator. */
export const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;

/** True when the text holds nothing but whitespace (a byte-order mark included). */
export function isBlank(text: string): boolean {
  return /^\s*$/.test(text);
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

/** Start offset of every line, numbered the way the scanner numbers them (line 1 starts at index 0). */
export function lineStartOffsets(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] as string;
    if (char === "\r") {
      // A CRLF pair is one break: skip the LF so it does not open a second line.
      if (source[index + 1] === "\n") index += 1;
      starts.push(index + 1);
    } else if (char === "\n" || char === "\u2028" || char === "\u2029") {
      starts.push(index + 1);
    }
  }
  return starts;
}
