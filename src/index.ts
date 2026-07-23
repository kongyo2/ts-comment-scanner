export { scanComments, type ScanOptions } from "./scanner.js";
export {
  collectFiles,
  decodeFileText,
  encodeFileText,
  isJsxFile,
  readFileText,
  scanFile,
  scanPaths,
  writeFileAtomic,
  type CollectOptions,
  type FileEncoding,
  type FileText,
} from "./files.js";
export { changedFiles } from "./git.js";
export { removeComments, type RemoveOptions, type RemoveResult } from "./remove.js";
export { detectDirective, isLegalComment, type DirectivePlacement } from "./directives.js";
export { formatText, formatJson, formatGitHub } from "./report.js";
export type { Comment, CommentKind, FileScanResult } from "./types.js";
