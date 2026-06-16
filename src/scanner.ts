import ts from "typescript";
import type { Comment, CommentKind } from "./types.js";

export interface ScanOptions {
  jsx?: boolean;
}

export function scanComments(source: string, options: ScanOptions = {}): Comment[] {
  const scriptKind = options.jsx === true ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile("module.ts", source, ts.ScriptTarget.Latest, true, scriptKind);

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

  const visit = (node: ts.Node): void => {
    const children = node.getChildren(sourceFile);
    if (children.length === 0) {
      if (node.kind === ts.SyntaxKind.JsxText) {
        jsxTextSpans.push([node.getFullStart(), node.getEnd()]);
      }
      collect(ts.getLeadingCommentRanges(source, node.getFullStart()));
      collect(ts.getTrailingCommentRanges(source, node.getEnd()));
      return;
    }
    for (const child of children) {
      visit(child);
    }
  };
  visit(sourceFile);

  const insideJsxText = (pos: number): boolean => jsxTextSpans.some(([start, end]) => pos >= start && pos < end);

  return ranges
    .filter((range) => !insideJsxText(range.pos))
    .sort((a, b) => a.pos - b.pos)
    .map((range) => {
      const kind: CommentKind = range.kind === ts.SyntaxKind.SingleLineCommentTrivia ? "line" : "block";
      const position = sourceFile.getLineAndCharacterOfPosition(range.pos);
      return {
        kind,
        text: source.slice(range.pos, range.end),
        start: range.pos,
        end: range.end,
        line: position.line + 1,
        column: position.character + 1,
      };
    });
}
