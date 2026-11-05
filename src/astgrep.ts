import { LINE_TERMINATOR, lineIndexAt, lineStartOffsets } from "./lines.js";
import type { Range } from "./ranges.js";

/**
 * Where ast-grep's suppression comments apply (`get_suppression_kind` in its
 * `crates/config/src/combined.rs`). ast-grep reads them off tree-sitter's
 * syntax tree, so positions here are tree-sitter's: rows end at a line feed
 * alone (a lone CR, U+2028 and U+2029 start no row), and whitespace is
 * JavaScript's plus U+200B and U+2060 (tree-sitter-javascript's extras).
 */
const TREE_SITTER_BLANK = /^[\s\u200B\u2060]*$/;
const TREE_SITTER_CONTENT = /[^\s\u200B\u2060]/;

/** Whether only whitespace, and no line feed, precedes the offset: the start of tree-sitter's first row. */
function opensFirstRow(text: string, offset: number): boolean {
  const before = text.slice(0, offset);
  return TREE_SITTER_BLANK.test(before) && !before.includes("\n");
}

/**
 * Whether a comment from `start` to `end` sits where an ast-grep suppression
 * covers the whole file (0.38.4 on): it opens the first row, and the next
 * node (code or another comment) starts two or more rows down, or nothing
 * follows at all.
 */
export function isFileWidePosition(text: string, start: number, end: number): boolean {
  if (!opensFirstRow(text, start)) return false;
  const next = text.slice(end).search(TREE_SITTER_CONTENT);
  return next === -1 || lineFeedCount(text.slice(0, end + next)) >= 2;
}

function lineFeedCount(text: string): number {
  return text.split("\n").length - 1;
}

/** Start offset of every tree-sitter row: the text's start and each offset just past a line feed. */
export function rowStartOffsets(text: string): number[] {
  return lineStartOffsets(text, /\n/);
}

/** What stands in front of a comment in tree-sitter's tree, which ast-grep reads a suppression's reach from. */
export interface PrecedingNode {
  /** Where the comment's previous sibling starts; absent when nothing precedes the comment. */
  start?: number;
  /** Where the last token in front of the comment ends, 0 when none does. */
  tokenEnd: number;
}

/** What a surviving ast-grep suppression needs the removal to leave in place. */
export interface AstGrepReach {
  /** Whether deleting the removal unit could change what the suppression covers. */
  holds(unit: Range): boolean;
  /**
   * The rest of its row and the next row when some release suppresses that
   * next row: the lines there have to stay, blank ones included.
   */
  nextRow: Range | undefined;
}

/**
 * What an ast-grep suppression comment covers depends on the node in front
 * of it (tree-sitter's previous sibling). From 0.44.0 the comment trails
 * that node when the node ends on the comment's row, and then covers the
 * matches starting on the row the node starts on; up to 0.43 it trails only
 * a node starting on its row, and covers that row. Otherwise it covers the
 * row after the one it starts on, which a comment spanning three rows fills
 * itself. Opening the first row, with the next node two rows down or nothing
 * after it, it covers the file.
 *
 * Every release has to read the same thing after the removal, so the
 * removal must not swap the node in front of the comment (the units after
 * the last token in front of it, on its row), nor join or split the rows a
 * release keys the comment to. Units holding a line break join or split rows
 * when deleted, so those ending on its row in front of it stay, as do those
 * after it on its row and those touching the row its node starts on; when a
 * release covers the next row, so do those starting there, and that row's
 * lines stay (see nextRow). On the first row, the units after it on the row
 * it ends on stay as well: the next node decides whether it covers the file.
 * The releases this follows parse with tree-sitter 0.24 or later (ast-grep
 * 0.31.1 on); before, comments in JSX braces read as standing alone.
 */
export function astGrepReach(
  text: string,
  rowStarts: readonly number[],
  comment: Range,
  preceding: PrecedingNode,
): AstGrepReach {
  const rowOf = (offset: number): number => lineIndexAt(rowStarts, offset);
  const rowStart = (row: number): number => rowStarts[row] ?? text.length;
  const breaks = (unit: Range): boolean => LINE_TERMINATOR.test(text.slice(unit.start, unit.end));
  const row = rowOf(comment.start);
  const endRow = rowOf(comment.end - 1);
  const ownRow = rowStart(row);
  // With nothing in front of it on its row, no node in front ends there.
  const trailing = TREE_SITTER_CONTENT.test(text.slice(ownRow, comment.start));
  const precedingRow = trailing && preceding.start !== undefined ? rowOf(preceding.start) : undefined;
  const coversNextRow = precedingRow !== row && endRow <= row + 1;
  const breaking: Range[] = [{ start: comment.end, end: rowStart(row + (coversNextRow ? 2 : 1)) }];
  if (precedingRow !== undefined && precedingRow < row) {
    breaking.push({ start: rowStart(precedingRow), end: rowStart(precedingRow + 1) });
  }
  const nextNode =
    endRow < 2 && opensFirstRow(text, comment.start) ? { start: comment.end, end: rowStart(endRow + 1) } : undefined;
  return {
    holds: (unit) =>
      (unit.end > ownRow && unit.end <= comment.start && (unit.start >= preceding.tokenEnd || breaks(unit))) ||
      (nextNode !== undefined && unit.start >= nextNode.start && unit.start < nextNode.end) ||
      (breaking.some((span) => unit.start < span.end && unit.end >= span.start) && breaks(unit)),
    nextRow: coversNextRow ? { start: comment.end, end: rowStart(row + 2) } : undefined,
  };
}
