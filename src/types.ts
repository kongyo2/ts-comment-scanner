export type CommentKind = "line" | "block";

export interface Comment {
  kind: CommentKind;
  text: string;
  start: number;
  end: number;
  line: number;
  column: number;
}

export interface FileScanResult {
  file: string;
  comments: Comment[];
}

export interface StripResult {
  file: string;
  removed: number;
  output: string;
  changed: boolean;
}
