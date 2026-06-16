import ts from "typescript";
import type { Comment, CommentKind } from "./types.js";

export function scanComments(source: string): Comment[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
  const sourceFile = ts.createSourceFile("module.ts", source, ts.ScriptTarget.Latest, false);
  const comments: Comment[] = [];

  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    const kind = commentKindOf(token);
    if (kind !== undefined) {
      const start = scanner.getTokenStart();
      const position = sourceFile.getLineAndCharacterOfPosition(start);
      comments.push({
        kind,
        text: scanner.getTokenText(),
        start,
        end: scanner.getTokenEnd(),
        line: position.line + 1,
        column: position.character + 1,
      });
    }
    token = scanner.scan();
  }

  return comments;
}

function commentKindOf(token: ts.SyntaxKind): CommentKind | undefined {
  if (token === ts.SyntaxKind.SingleLineCommentTrivia) return "line";
  if (token === ts.SyntaxKind.MultiLineCommentTrivia) return "block";
  return undefined;
}
