export { scanComments, type ScanOptions } from "./scanner.js";
export { stripComments } from "./strip.js";
export {
  collectFiles,
  scanFile,
  scanPaths,
  stripFile,
  stripPaths,
  type CollectOptions,
  type StripOptions,
} from "./files.js";
export { formatText, formatJson, formatStripSummary } from "./report.js";
export type { Comment, CommentKind, FileScanResult, StripResult } from "./types.js";
