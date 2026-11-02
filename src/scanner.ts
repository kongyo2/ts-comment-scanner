import ts from "typescript";
import { bunMarkerOffset, detectDirective, type DirectivePlacement } from "./directives.js";
import { jsxLayout, type JsxLayout } from "./jsx.js";
import { isBlank } from "./lines.js";
import { firstIndexAtOrAfter } from "./ranges.js";
import type { Comment, CommentKind } from "./types.js";

export interface ScanOptions {
  jsx?: boolean;
}

export function scanComments(source: string, options: ScanOptions = {}): Comment[] {
  return analyzeSource(source, options).comments;
}

/** A source's comments together with the layout of its JSX children, from a single parse. */
export interface SourceAnalysis {
  comments: Comment[];
  jsx: JsxLayout;
}

export function analyzeSource(source: string, options: ScanOptions = {}): SourceAnalysis {
  const jsx = options.jsx === true;
  const fileName = jsx ? "module.tsx" : "module.ts";
  const scriptKind = jsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);

  const jsxTextSpans: Array<[number, number]> = [];
  const jsxParents: Array<ts.JsxElement | ts.JsxFragment> = [];
  const ranges: ts.CommentRange[] = [];
  const seen = new Set<number>();
  /** Every token, in document order. */
  const tokens: ts.Node[] = [];

  const collect = (found: readonly ts.CommentRange[] | undefined): void => {
    if (!found) return;
    for (const range of found) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      ranges.push(range);
    }
  };

  // Iterative depth-first walk: generated or minified sources nest thousands
  // of expressions deep, where a recursive visitor overflows the call stack
  // even though the parse itself succeeded.
  const pending: ts.Node[] = [sourceFile];
  while (pending.length > 0) {
    const node = pending.pop() as ts.Node;
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) jsxParents.push(node);
    // JSDoc nodes start inside the comment text itself; descending into them
    // would hide the comment (e.g. a trailing JSDoc attached to the
    // end-of-file token). Treat them as trivia like any other comment.
    const children = node.getChildren(sourceFile).filter((child) => !ts.isJSDoc(child));
    if (children.length === 0) {
      tokens.push(node);
      if (node.kind === ts.SyntaxKind.JsxText) {
        jsxTextSpans.push([node.getFullStart(), node.getEnd()]);
      }
      collect(ts.getLeadingCommentRanges(source, node.getFullStart()));
      collect(ts.getTrailingCommentRanges(source, node.getEnd()));
      continue;
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push(children[index] as ts.Node);
    }
  }

  // JsxText spans never overlap, so a position is inside one exactly when it
  // is inside the closest span starting at or before it — found by binary
  // search, keeping comment-dense TSX files out of quadratic time.
  jsxTextSpans.sort((a, b) => a[0] - b[0]);
  const insideJsxText = (pos: number): boolean => {
    let low = 0;
    let high = jsxTextSpans.length - 1;
    let candidate = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if ((jsxTextSpans[middle] as [number, number])[0] <= pos) {
        candidate = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return candidate >= 0 && pos < (jsxTextSpans[candidate] as [number, number])[1];
  };

  const sorted = ranges.filter((range) => !insideJsxText(range.pos)).sort((a, b) => a.pos - b.pos);

  // Directive rules with positional requirements (header pragmas, prettier's
  // first-comment docblock, Bun's file-start marker) get the comment's actual
  // placement; a shebang does not count as content before the first comment,
  // matching jest-docblock.
  const firstTokenStart = sourceFile.getStart(sourceFile);
  const shebangEnd = ts.getShebang(source)?.length ?? 0;
  const firstCommentPos = sorted.length > 0 ? (sorted[0] as ts.CommentRange).pos : -1;
  const bunMarkerPos = bunMarkerOffset(source);
  // The token after a comment, past any further comments: no token overlaps
  // a comment, so it is the first one ending at or past the comment's end
  // (the end-of-file token ends at the text's end). Token ends never
  // decrease in document order, so a binary search finds it — without
  // skipping the leading trivia a token start would need.
  const tokenAfter = (offset: number): ts.Node =>
    tokens[firstIndexAtOrAfter(tokens, offset, (token) => token.end)] as ts.Node;
  const placementOf = (range: ts.CommentRange): DirectivePlacement => {
    // The switch slots walk the syntax tree, so they are worked out only for
    // the comments a switch-clause rule matched, when it asks.
    let slots: ReturnType<typeof switchSlots> | undefined;
    const slotsOf = (): ReturnType<typeof switchSlots> => (slots ??= switchSlots(tokenAfter(range.end)));
    const firstComment = range.pos === firstCommentPos;
    return {
      header: range.pos < firstTokenStart,
      firstComment: firstComment && /^\s*$/.test(source.slice(shebangEnd, range.pos)),
      fileStart: range.pos === bunMarkerPos,
      fileWide: firstComment && isFileWidePosition(source, range.pos, range.end),
      get fallthroughSlot() {
        return slotsOf().fallthroughSlot;
      },
      get noDefaultSlot() {
        return slotsOf().noDefaultSlot;
      },
    };
  };

  const comments = sorted.map((range): Comment => {
    const kind: CommentKind = range.kind === ts.SyntaxKind.SingleLineCommentTrivia ? "line" : "block";
    const text = source.slice(range.pos, range.end);
    const startPosition = sourceFile.getLineAndCharacterOfPosition(range.pos);
    const endPosition = sourceFile.getLineAndCharacterOfPosition(range.end);
    const directive = detectDirective(kind, text, placementOf(range));
    return {
      kind,
      text,
      start: range.pos,
      end: range.end,
      line: startPosition.line + 1,
      column: startPosition.character + 1,
      endLine: endPosition.line + 1,
      endColumn: endPosition.character + 1,
      ...(directive === undefined ? {} : { directive }),
    };
  });

  return { comments, jsx: jsxLayout(source, sourceFile, jsxParents, comments) };
}

/**
 * Whether a comment from `start` to `end` sits where ast-grep's suppression
 * comment covers the whole file (`get_suppression_kind` in its `combined.rs`):
 * on the first line with nothing but whitespace in front of it, and with the
 * next node — code or another comment — starting two or more lines further
 * down, or with nothing after it at all. Lines are counted the way tree-sitter
 * counts its rows, by line feeds alone.
 */
export function isFileWidePosition(text: string, start: number, end: number): boolean {
  if (!opensFirstRow(text, start)) return false;
  const next = text.slice(end).search(/\S/);
  return next === -1 || lineFeedCount(text.slice(0, end + next)) >= 2;
}

/** Whether nothing but whitespace, and no line feed, precedes the offset: the start of tree-sitter's first row. */
export function opensFirstRow(text: string, offset: number): boolean {
  const before = text.slice(0, offset);
  return isBlank(before) && !before.includes("\n");
}

function lineFeedCount(text: string): number {
  return text.split("\n").length - 1;
}

/**
 * The switch slots (see DirectivePlacement) a comment in front of the given
 * token sits in. The token is what follows the comment past any further
 * comments — the end-of-file token at the latest, whose parent is the file.
 */
function switchSlots(token: ts.Node): { fallthroughSlot: boolean; noDefaultSlot: boolean } {
  let fallthroughSlot = false;
  let noDefaultSlot = false;
  const parent = token.parent;
  if (
    (token.kind === ts.SyntaxKind.CaseKeyword || token.kind === ts.SyntaxKind.DefaultKeyword) &&
    ts.isCaseOrDefaultClause(parent)
  ) {
    // In front of a clause: where ESLint, oxlint and deno_lint read the
    // comment saying the clause before it falls through — so not the first.
    fallthroughSlot = parent.parent.clauses[0] !== parent;
  } else if (
    token.kind === ts.SyntaxKind.CloseBraceToken &&
    ts.isBlock(parent) &&
    ts.isCaseOrDefaultClause(parent.parent)
  ) {
    // Inside a block that is the last statement of a clause (its only one,
    // for ESLint and oxlint), in front of its closing brace — read when
    // another clause follows.
    const clause = parent.parent;
    const clauses = clause.parent.clauses;
    fallthroughSlot = clause.statements.at(-1) === parent && clauses.at(-1) !== clause;
  } else if (token.kind === ts.SyntaxKind.CloseBraceToken && ts.isCaseBlock(parent)) {
    // After the last clause of a switch, in front of its closing brace:
    // where ESLint's default-case reads its comment.
    noDefaultSlot = lacksDefaultClause(parent);
  }
  // oxlint's default-case reads the last comment from the last clause's
  // start to the switch's end, so the comments inside that clause count too
  // — all but one in front of the clause's opening `case`.
  for (let node = parent; !noDefaultSlot && !ts.isSourceFile(node); node = node.parent) {
    noDefaultSlot =
      ts.isCaseClause(node) &&
      node.parent.clauses.at(-1) === node &&
      lacksDefaultClause(node.parent) &&
      (node !== parent || token.kind !== ts.SyntaxKind.CaseKeyword);
  }
  return { fallthroughSlot, noDefaultSlot };
}

/** Whether the switch has clauses but none of them is a default clause. */
function lacksDefaultClause(caseBlock: ts.CaseBlock): boolean {
  return caseBlock.clauses.length > 0 && !caseBlock.clauses.some(ts.isDefaultClause);
}
