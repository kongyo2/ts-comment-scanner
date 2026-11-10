import type { CommentKind } from "./types.js";

/**
 * How the coverage tools that count lines read an `ignore next` hint. Each
 * reads it its own way, on its own lines:
 *
 * - c8 (v8-to-istanbul's `source.js`) and Node's test runner (its
 *   `coverage.js`) search the file's text row by row, a row ending at a line
 *   feed alone, for the hint spelled as a block comment with single spaces —
 *   wherever that text stands: inside another comment, a string or a
 *   template too.
 * - monocart-coverage-reports reads the comments themselves, on lines that
 *   every ECMAScript line terminator ends.
 *
 * istanbul and ast-v8-to-istanbul, Vitest's providers, apply the hint to the
 * node after it instead, whatever count follows — ast-v8-to-istanbul only to
 * the node that starts at the very token after the comment (see hintsNextNode).
 */

// The text v8-to-istanbul looks for in a row; the form Node reads opens with it too.
const TEXT_HINT = /\/\* (?:[cv]8|node:coverage) ignore next/g;
// The count v8-to-istanbul reads right behind it.
const COUNT = / ([0-9]+)/y;
// Node's test runner wants the whole comment, a count and its space included.
const NODE_HINT = /\/\* node:coverage ignore next (\d+ )?\*\//y;

/** An `ignore next` hint in the text of a file, as the tools that search the text for it find it. */
export interface TextHint {
  /** Where the hint's `/*` stands. */
  offset: number;
  /**
   * The rows below its own that v8-to-istanbul ignores for it where the hint
   * opens its row (see opensRow): the count behind it, or one. Anywhere else
   * on a row the hint covers that row alone.
   */
  rows: number;
  /** The rows below its own that Node's test runner ignores for it; none when Node does not read it. */
  nodeRows: number;
}

/** The `ignore next` hints v8-to-istanbul and Node's test runner find in the text. */
export function textHints(source: string): TextHint[] {
  const hints: TextHint[] = [];
  for (const match of source.matchAll(TEXT_HINT)) {
    COUNT.lastIndex = match.index + match[0].length;
    NODE_HINT.lastIndex = match.index;
    const node = NODE_HINT.exec(source);
    hints.push({
      offset: match.index,
      rows: Number(COUNT.exec(source)?.[1] ?? 1),
      nodeRows: node === null ? 0 : Number(node[1] ?? 1),
    });
  }
  return hints;
}

/**
 * Whether a hint that `prefix` precedes on its row opens the row to
 * v8-to-istanbul, which then counts the rows below it: nothing but non-word
 * characters stands in front of it (`^\W*` in its patterns), so `});` does
 * not keep the hint from counting, and a comment that holds a word does.
 */
export function opensRow(prefix: string): boolean {
  return /^\W*$/.test(prefix);
}

/**
 * The lines below the comment's last that monocart-coverage-reports ignores
 * for it, or undefined when it reads no `ignore next` from the comment. It
 * wants the trimmed value to open with `v8 ignore`, `c8 ignore` or
 * `node:coverage`, and `next` (`ignore next` for Node's) to open what follows
 * past any whitespace; then it takes the leading integer of the rest as the
 * count (`next3` and `next 3x` count 3), and one line for anything else.
 * Without a count, a block comment that something follows on its line —
 * `trailing`, the rest of that line — covers no line below: the hint is for
 * what follows it there.
 */
export function monocartLines(kind: CommentKind, text: string, trailing: string): number | undefined {
  const value = (kind === "block" ? text.slice(2, -2) : text.slice(2)).trim();
  const tool = ["v8 ignore", "c8 ignore", "node:coverage"].find((name) => value.startsWith(name));
  if (tool === undefined) return undefined;
  const mode = tool === "node:coverage" ? "ignore next" : "next";
  const rest = value.slice(tool.length).trim();
  if (!rest.startsWith(mode)) return undefined;
  const count = rest.slice(mode.length).trim();
  // (monocart calls parseInt without a radix.)
  if (count !== "") return Math.max(1, Number.parseInt(count) || 1);
  return kind === "block" && trailing.trim() !== "" ? 0 : 1;
}

// What ast-v8-to-istanbul wants at the start of a comment's text, its delimiters cut off.
const NEXT_NODE_HINT = /^\s*(?:istanbul|[cv]8|node:coverage)\s+ignore\s+(?:if|else|next)(?=\W|$)/;

/**
 * Whether ast-v8-to-istanbul, Vitest's v8 provider, reads a hint for the next
 * node from the comment: `ignore next`, `ignore if` or `ignore else` at the
 * start of its text (`getIgnoreHints` in its ignore-hints.ts). It applies
 * such a hint to the node starting at the first token after the comment, so
 * a hint that another comment follows has no target. A hint further into the
 * text (`// see /* c8 ignore next *​/`) is c8's to read, not this tool's.
 */
export function hintsNextNode(text: string): boolean {
  const value = text
    .replace(/^\/\*\*/, "")
    .replace(/^\/\*/, "")
    .replace(/\*\*\/$/, "")
    .replace(/\*\/$/, "")
    .replace(/^\/\//, "");
  return NEXT_NODE_HINT.test(value);
}
