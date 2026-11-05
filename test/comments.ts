import { scanComments } from "../src/scanner.js";
import type { CommentKind } from "../src/types.js";

/** The kind of comment the text spells: a line comment when it opens with `//`, a block comment otherwise. */
export function kindOf(comment: string): CommentKind {
  return comment.startsWith("//") ? "line" : "block";
}

/** Whether the scanner names a comment of the source with one of the directives. */
export function hasDirective(source: string, names: readonly string[]): boolean {
  return scanComments(source).some((comment) => comment.directive !== undefined && names.includes(comment.directive));
}
