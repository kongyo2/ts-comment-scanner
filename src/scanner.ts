import ts from "typescript";
import { isFileWidePosition, type PrecedingNode } from "./astgrep.js";
import { bunMarkerOffset, carriesAstGrepSuppression, detectDirective, type DirectivePlacement } from "./directives.js";
import { importGroupGaps, type ImportGroupGap } from "./imports.js";
import { jsxLayout, type JsxLayout } from "./jsx.js";
import { firstIndexAtOrAfter, rangeAt, type Range } from "./ranges.js";
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
  /** What stands in front of each comment carrying an ast-grep suppression (see precedingNode). */
  preceding: ReadonlyMap<Comment, PrecedingNode>;
  /**
   * The gaps in front of the import and export declarations the import
   * sorters group, and in front of the statements after imports, where the
   * linters want an empty line (see importGroupGaps).
   */
  importGroups: ImportGroupGap[];
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
  /**
   * The insides of the blocks with no statements and the switches with no
   * clauses (see DirectivePlacement.emptyBlock), from just past the opening
   * brace to the block's end — from the `static` keyword on for a class
   * static block — in document order. Nothing but comments sits in such a
   * block, so no two of them overlap.
   */
  const emptyBlocks: Range[] = [];

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
    if ((ts.isBlock(node) && node.statements.length === 0) || (ts.isCaseBlock(node) && node.clauses.length === 0)) {
      // A block the parser had to make up, with no opening brace, holds nothing.
      const start = node.getStart(sourceFile);
      if (source[start] === "{") {
        // oxlint's no-empty-static-block counts the comments of the whole
        // static block, `static /* c */ {}` included (its span starts at the
        // keyword); no comment starts inside the keyword itself.
        const from = ts.isClassStaticBlockDeclaration(node.parent) ? node.parent.getStart(sourceFile) : start + 1;
        emptyBlocks.push({ start: from, end: node.end });
      }
    }
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
  const emptyFile = holdsNoCode(sourceFile);
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
      // A comment opening the first row has only whitespace in front of it,
      // so only the first comment needs the check.
      fileWide: firstComment && isFileWidePosition(source, range.pos, range.end),
      emptyBlock: rangeAt(emptyBlocks, range.pos) !== undefined,
      emptyFile,
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

  const preceding = new Map<Comment, PrecedingNode>();
  for (const [index, comment] of comments.entries()) {
    if (carriesAstGrepSuppression(comment.text)) {
      preceding.set(comment, precedingNode(sourceFile, tokens, comments[index - 1], comment.start));
    }
  }

  return {
    comments,
    jsx: jsxLayout(source, sourceFile, jsxParents, comments),
    preceding,
    importGroups: importGroupGaps(source, sourceFile, comments),
  };
}

/**
 * What stands in front of the comment at `offset` in tree-sitter's tree.
 * tree-sitter puts a comment in the innermost node with code on both sides
 * of it, so the comment's previous sibling is the comment right before it
 * when no token stands between them, and otherwise the outermost node that
 * ends with the token before it. TypeScript's nodes end where tree-sitter's
 * do, except that tree-sitter's automatic semicolon can take a trailing
 * comment into its statement, which makes the sibling smaller and starting
 * no earlier: the start read off here is never on a later row.
 */
function precedingNode(
  sourceFile: ts.SourceFile,
  tokens: readonly ts.Node[],
  previous: Comment | undefined,
  offset: number,
): PrecedingNode {
  // Empty lists are leaves too, as are missing tokens; neither holds text.
  let index = firstIndexAtOrAfter(tokens, offset + 1, (token) => token.end) - 1;
  while (index >= 0 && (tokens[index] as ts.Node).getStart(sourceFile) >= (tokens[index] as ts.Node).end) index -= 1;
  const token = tokens[index];
  const tokenEnd = token?.end ?? 0;
  if (previous !== undefined && previous.end > tokenEnd) return { start: previous.start, tokenEnd };
  if (token === undefined) return { tokenEnd };
  let node = token;
  while (!ts.isSourceFile(node.parent) && node.parent.end === token.end) node = node.parent;
  return { start: node.getStart(sourceFile), tokenEnd };
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

/**
 * Whether the file holds no code, as the no-empty-file rules of oxlint and
 * eslint-plugin-unicorn read it (see DirectivePlacement.emptyFile): every
 * statement is an empty one or a block of nothing else, past the directive
 * prologue — the string-literal statements that open the file.
 */
function holdsNoCode(sourceFile: ts.SourceFile): boolean {
  let prologue = true;
  return sourceFile.statements.every((statement) => {
    prologue &&= ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression);
    return prologue || isEmptyStatement(statement);
  });
}

function isEmptyStatement(statement: ts.Statement): boolean {
  return ts.isEmptyStatement(statement) || (ts.isBlock(statement) && statement.statements.every(isEmptyStatement));
}
