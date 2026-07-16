export { scanComments, type ScanOptions } from "./scanner.js";
export { collectFiles, isJsxFile, scanFile, scanPaths, type CollectOptions } from "./files.js";
export { changedFiles } from "./git.js";
export { removeComments, type RemoveOptions, type RemoveResult } from "./remove.js";
export { detectDirective, isLegalComment } from "./directives.js";
export { formatText, formatJson, formatGitHub } from "./report.js";
export type { Comment, CommentKind, FileScanResult } from "./types.js";
