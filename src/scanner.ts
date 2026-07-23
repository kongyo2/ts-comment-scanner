import ts from "typescript";
import { detectDirective, type DirectivePlacement } from "./directives.js";
import type { Comment, CommentKind } from "./types.js";

export interface ScanOptions {
  jsx?: boolean;
}

export function scanComments(source: string, options: ScanOptions = {}): Comment[] {
  const jsx = options.jsx === true;
  const fileName = jsx ? "module.tsx" : "module.ts";
  const scriptKind = jsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);

  const jsxTextSpans: Array<[number, number]> = [];
  const ranges: ts.CommentRange[] = [];
  const seen = new Set<number>();

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
    // JSDoc nodes start inside the comment text itself; descending into them
    // would hide the comment (e.g. a trailing JSDoc attached to the
    // end-of-file token). Treat them as trivia like any other comment.
    const children = node.getChildren(sourceFile).filter((child) => !ts.isJSDoc(child));
    if (children.length === 0) {
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
  const placementOf = (pos: number): DirectivePlacement => ({
    header: pos < firstTokenStart,
    firstComment: pos === firstCommentPos && /^\s*$/.test(source.slice(shebangEnd, pos)),
    fileStart: pos === 0,
  });

  return sorted.map((range) => {
    const kind: CommentKind = range.kind === ts.SyntaxKind.SingleLineCommentTrivia ? "line" : "block";
    const text = source.slice(range.pos, range.end);
    const startPosition = sourceFile.getLineAndCharacterOfPosition(range.pos);
    const endPosition = sourceFile.getLineAndCharacterOfPosition(range.end);
    const directive = detectDirective(kind, text, placementOf(range.pos));
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
}
