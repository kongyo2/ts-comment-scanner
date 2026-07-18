import ts from "typescript";
import { detectDirective } from "./directives.js";
import type { Comment, CommentKind } from "./types.js";

export interface ScanOptions {
  jsx?: boolean;
}

// dprint-ignore-file is deliberately absent: a stray one below the header no
// longer skips the file, but dprint's node pragma still matches inside it, so
// the comment stays an active `dprint-ignore` and must keep its tag.
const HEADER_ONLY_DIRECTIVES = new Set([
  "@ts-nocheck",
  "@ts-check",
  "@format",
  "@noformat",
  "@prettier",
  "@noprettier",
  "@flow",
  "@noflow",
  "@bun",
  "@ts-self-types",
  "jslint",
  "property",
]);

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

  const visit = (node: ts.Node): void => {
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
      return;
    }
    for (const child of children) {
      visit(child);
    }
  };
  visit(sourceFile);

  const insideJsxText = (pos: number): boolean => jsxTextSpans.some(([start, end]) => pos >= start && pos < end);

  // File-wide pragmas (check pragmas, triple-slash directives, prettier's
  // docblock pragma mode, Flow/Bun/JSLint header pragmas, Deno's
  // *-ignore-file and @ts-self-types forms) only count before the first
  // token; anywhere later the tools treat them as ordinary text. Coverage
  // file pragmas (`istanbul ignore file`, `c8/v8 ignore file`) are NOT
  // gated: istanbul-lib-instrument and Vitest's v8 provider
  // (ast-v8-to-istanbul) honour them on any comment in the file. Test
  // environment pragmas are not gated either: Vitest matches them (including
  // the @jest- spellings) with a regex over the whole file, and neither are
  // @ts-strict pragmas (typescript-strict-plugin scans every line).
  const firstTokenStart = sourceFile.getStart(sourceFile);
  const isHeaderOnlyDirective = (directive: string): boolean =>
    HEADER_ONLY_DIRECTIVES.has(directive) ||
    (directive.startsWith("deno-") && directive.endsWith("-ignore-file")) ||
    directive.startsWith("triple-slash-");
  const isActiveDirective = (directive: string, pos: number): boolean =>
    !isHeaderOnlyDirective(directive) || pos < firstTokenStart;

  return ranges
    .filter((range) => !insideJsxText(range.pos))
    .sort((a, b) => a.pos - b.pos)
    .map((range) => {
      const kind: CommentKind = range.kind === ts.SyntaxKind.SingleLineCommentTrivia ? "line" : "block";
      const text = source.slice(range.pos, range.end);
      const startPosition = sourceFile.getLineAndCharacterOfPosition(range.pos);
      const endPosition = sourceFile.getLineAndCharacterOfPosition(range.end);
      const detected = detectDirective(kind, text);
      const directive = detected !== undefined && isActiveDirective(detected, range.pos) ? detected : undefined;
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
