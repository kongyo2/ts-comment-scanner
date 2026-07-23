import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import picomatch from "picomatch";
import { scanComments } from "./scanner.js";
import type { FileScanResult } from "./types.js";

const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const DEFAULT_IGNORE_DIRS = ["node_modules", ".git"];

export interface CollectOptions {
  /** File extensions to include (with or without a leading dot, case-insensitive). */
  extensions?: string[];
  /**
   * Directory names that are never traversed, input directories included
   * (case-insensitively on Windows). Default: node_modules, .git
   */
  ignoreDirs?: string[];
  /**
   * Glob patterns for files and directories to skip (picomatch syntax).
   * Patterns without a slash match against base names, e.g. `*.test.ts`.
   * Explicitly listed input files bypass these patterns.
   */
  ignore?: string[];
}

type IgnoreMatcher = (path: string, root: string) => boolean;

export async function collectFiles(inputs: string[], options: CollectOptions = {}): Promise<string[]> {
  const extensions = normalizeExtensions(options.extensions ?? DEFAULT_EXTENSIONS);
  const ignoreDirs = new Set((options.ignoreDirs ?? DEFAULT_IGNORE_DIRS).map(foldName));
  const isIgnored = buildIgnoreMatcher(options.ignore ?? []);
  // Keyed by the real path so different spellings of one file (relative vs
  // absolute, `.` segments, case on Windows, symlink aliases) collapse into a
  // single entry; the first spelling seen is the one reported.
  const found = new Map<string, string>();
  const remember = (path: string, realPath: string): void => {
    const key = canonicalKey(realPath);
    if (!found.has(key)) found.set(key, path);
  };

  await Promise.all(
    inputs.map(async (rawInput) => {
      if (rawInput === "") {
        // normalize("") would resolve to "." and silently widen the scan.
        throw new Error("empty path is not a valid input");
      }
      const input = normalize(rawInput);
      const info = await statInput(input);
      if (info.isDirectory()) {
        // Directory inputs are themselves subject to the ignored directory
        // names and the ignore patterns; only explicitly listed files bypass
        // them.
        if (!ignoreDirs.has(foldName(basename(input))) && !isIgnored(input, input)) {
          await walk(input, { extensions, ignoreDirs, isIgnored, root: input, visited: new Set() }, remember);
        }
      } else {
        remember(input, await realpathInput(input));
      }
    }),
  );

  return [...found.values()].sort();
}

function canonicalKey(path: string): string {
  const resolved = resolve(path);
  // Windows paths are case-insensitive; a case-folded key keeps `Foo.ts` and
  // `foo.ts` from being treated as two files.
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Folds directory names the way the platform compares them, matching canonicalKey. */
function foldName(name: string): string {
  return process.platform === "win32" ? name.toLowerCase() : name;
}

async function statInput(input: string): Promise<Stats> {
  try {
    return await stat(input);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`path not found: ${input}`, { cause: error });
    }
    throw error;
  }
}

/** Real path of an explicit input, with the same friendly error statInput gives. */
async function realpathInput(input: string): Promise<string> {
  try {
    return await realpath(input);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`path not found: ${input}`, { cause: error });
    }
    throw error;
  }
}

/**
 * True for the errors a walk may step over: entries that vanished mid-walk
 * (ENOENT, ENOTDIR after a directory was replaced) and symlinks that do not
 * resolve (broken targets, ELOOP cycles). Anything else — permissions, I/O
 * failures — propagates, so a partial scan cannot masquerade as a clean one.
 */
function isSkippableWalkError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

interface WalkContext {
  extensions: string[];
  ignoreDirs: Set<string>;
  isIgnored: IgnoreMatcher;
  /** Top-level directory this walk started from; ignore globs also match relative to it. */
  root: string;
  /** Real paths of directories already walked, so symlink cycles and diamonds terminate. */
  visited: Set<string>;
}

async function walk(
  dir: string,
  context: WalkContext,
  remember: (path: string, realPath: string) => void,
): Promise<void> {
  let real: string;
  try {
    real = await realpath(dir);
  } catch (error) {
    if (isSkippableWalkError(error)) return; // the directory vanished mid-walk
    throw error;
  }
  if (context.visited.has(real)) return;
  context.visited.add(real);

  const entries = await readdir(dir, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name);
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        // Symlinks are followed, matching how explicitly listed inputs are
        // stat()ed; the visited set above keeps cycles from recursing forever.
        try {
          const info = await stat(full);
          isDirectory = info.isDirectory();
          isFile = info.isFile();
        } catch (error) {
          if (isSkippableWalkError(error)) return; // broken symlink
          throw error;
        }
      }
      if (isDirectory) {
        if (!context.ignoreDirs.has(foldName(entry.name)) && !context.isIgnored(full, context.root)) {
          await walk(full, context, remember);
        }
      } else if (isFile && hasExtension(entry.name, context.extensions) && !context.isIgnored(full, context.root)) {
        // Remembered under its real path, so several symlinks to one target
        // (or a link plus the target itself) count — and get rewritten — once.
        let realFile: string;
        try {
          realFile = await realpath(full);
        } catch (error) {
          if (isSkippableWalkError(error)) return; // the file vanished mid-walk
          throw error;
        }
        remember(full, realFile);
      }
    }),
  );
}

function normalizeExtensions(extensions: string[]): string[] {
  return extensions.map((extension) => {
    const withDot = extension.startsWith(".") ? extension : `.${extension}`;
    return withDot.toLowerCase();
  });
}

/** Suffix match so compound extensions like `.d.ts` work; `extname` would only see `.ts`. */
function hasExtension(name: string, extensions: string[]): boolean {
  const lower = name.toLowerCase();
  return extensions.some((extension) => lower.endsWith(extension));
}

function buildIgnoreMatcher(patterns: string[]): IgnoreMatcher {
  if (patterns.length === 0) return () => false;

  // Gitignore-like split: patterns without a slash match base names, patterns
  // with a slash match whole paths. (picomatch's `basename` option would apply
  // to every pattern, breaking path globs, so two matchers are needed.)
  const matchers: Array<(path: string) => boolean> = [];
  const byBasename = patterns.filter((pattern) => !pattern.includes("/"));
  const byPath = patterns.filter((pattern) => pattern.includes("/"));
  if (byBasename.length > 0) matchers.push(picomatch(byBasename, { dot: true, basename: true }));
  if (byPath.length > 0) matchers.push(picomatch(byPath, { dot: true }));
  const match = (path: string): boolean => matchers.some((matcher) => matcher(path));

  // Anchored patterns like `src/legacy/**` are tried against the path as
  // spelled, relative to the scanned root, and relative to the working
  // directory, so they work regardless of where the scan was started from.
  return (path, root) => {
    if (match(toPosix(path))) return true;
    return relativeMatches(root, path, match) || relativeMatches(process.cwd(), path, match);
  };
}

function relativeMatches(base: string, path: string, match: (path: string) => boolean): boolean {
  const relativePath = relative(base, path);
  if (relativePath === "" || isAbsolute(relativePath)) return false;
  // Only a leading `..` *segment* means "outside the base": a directory that
  // merely starts with two dots (`..hidden`) is inside it and must still be
  // matched against the ignore globs.
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) return false;
  return match(toPosix(relativePath));
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

export function isJsxFile(file: string): boolean {
  const lower = file.toLowerCase();
  return lower.endsWith(".tsx") || lower.endsWith(".jsx");
}

export type FileEncoding = "utf8" | "utf16le" | "utf16be";

export interface FileText {
  /** Decoded content with any byte-order mark stripped. */
  text: string;
  encoding: FileEncoding;
  /** Whether the file carried a byte-order mark. */
  bom: boolean;
  /**
   * Whether re-encoding `text` reproduces the original bytes exactly. False
   * for invalid UTF-8 (decoded with replacement characters), truncated
   * UTF-16 and other undecodable input; such files must not be rewritten.
   */
  lossless: boolean;
}

/**
 * Decodes a source file. UTF-16 (either endianness) is recognised by its
 * byte-order mark; everything else is treated as UTF-8. Positions reported by
 * the scanner are relative to the decoded, BOM-stripped text, matching
 * editors, GitHub annotations and the removal report.
 */
export function decodeFileText(data: Buffer): FileText {
  let encoding: FileEncoding = "utf8";
  let bom = false;
  let body = data;
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
    encoding = "utf16le";
    bom = true;
    body = data.subarray(2);
  } else if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
    encoding = "utf16be";
    bom = true;
    body = data.subarray(2);
  } else if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    bom = true;
    body = data.subarray(3);
  }
  const text = encoding === "utf16be" ? decodeUtf16Be(body) : body.toString(encoding);
  const lossless = encodeFileText(text, { encoding, bom }).equals(data);
  return { text, encoding, bom, lossless };
}

function decodeUtf16Be(body: Buffer): string {
  // swap16() refuses odd-length buffers; drop the dangling byte the same way
  // the LE decoder does and let the lossless round-trip flag the truncation.
  const even = body.length % 2 === 0 ? body : body.subarray(0, body.length - 1);
  return Buffer.from(even).swap16().toString("utf16le");
}

/**
 * Re-encodes decoded text in the encoding (and BOM) it was read with. Note
 * that `bom: false` UTF-16 output cannot be recognised by decodeFileText,
 * which identifies UTF-16 by its byte-order mark — request it only for
 * consumers that expect mark-less UTF-16.
 */
export function encodeFileText(text: string, target: { encoding: FileEncoding; bom: boolean }): Buffer {
  const body =
    target.encoding === "utf16le"
      ? Buffer.from(text, "utf16le")
      : target.encoding === "utf16be"
        ? Buffer.from(text, "utf16le").swap16()
        : Buffer.from(text, "utf8");
  if (!target.bom) return body;
  const bom =
    target.encoding === "utf16le"
      ? Buffer.from([0xff, 0xfe])
      : target.encoding === "utf16be"
        ? Buffer.from([0xfe, 0xff])
        : Buffer.from([0xef, 0xbb, 0xbf]);
  return Buffer.concat([bom, body]);
}

export async function readFileText(file: string): Promise<FileText> {
  return decodeFileText(await readFile(file));
}

/**
 * Replaces a file's content atomically: the data is written to a temporary
 * sibling, flushed, and renamed into place, so a crash, full disk or write
 * error can never leave the target truncated. Symlinks are followed (the
 * link's target is replaced, not the link) and the file mode is preserved.
 */
export async function writeFileAtomic(file: string, data: Buffer): Promise<void> {
  const target = await realpath(file);
  const mode = (await stat(target)).mode;
  const temp = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temp, "wx", mode);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // open()'s mode is filtered through the umask; restore the original exactly.
    await chmod(temp, mode & 0o7777);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function scanFile(file: string): Promise<FileScanResult> {
  const { text } = await readFileText(file);
  return { file, comments: scanComments(text, { jsx: isJsxFile(file) }) };
}

export async function scanPaths(inputs: string[], options: CollectOptions = {}): Promise<FileScanResult[]> {
  const files = await collectFiles(inputs, options);
  return mapLimit(files, FILE_CONCURRENCY, scanFile);
}

export const FILE_CONCURRENCY = 16;

/** Concurrency-limited map that keeps input order and starts work as slots free up. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const claimNext = async (): Promise<void> => {
    const index = nextIndex;
    nextIndex += 1;
    if (index >= items.length) return;
    results[index] = await fn(items[index] as T);
    return claimNext();
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, claimNext));
  return results;
}
