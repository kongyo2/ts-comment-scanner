export type CommentKind = "line" | "block";

export interface Comment {
  kind: CommentKind;
  text: string;
  start: number;
  end: number;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  /** Canonical name of the compiler/linter directive this comment represents, if any. */
  directive?: string;
}

export interface FileScanResult {
  file: string;
  comments: Comment[];
}
