import { randomUUID } from "node:crypto";
import { chmod, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import picomatch from "picomatch";
import { scanComments, type ScanOptions } from "./scanner.js";
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
   * Patterns without a slash match against base names, e.g. `*.test.ts`;
   * a trailing slash restricts a pattern to directories, e.g. `dist/`, like
   * in .gitignore. Explicitly listed input files bypass these patterns.
   */
  ignore?: string[];
}

/** Whether the path (a directory when `isDirectory`) is excluded by the ignore patterns. */
type IgnoreMatcher = (path: string, root: string, isDirectory: boolean) => boolean;

export async function collectFiles(inputs: string[], options: CollectOptions = {}): Promise<string[]> {
  const patterns = options.ignore ?? [];
  const context: WalkContext = {
    extensions: normalizeExtensions(options.extensions ?? DEFAULT_EXTENSIONS),
    ignoreDirs: new Set((options.ignoreDirs ?? DEFAULT_IGNORE_DIRS).map(foldPathCase)),
    isIgnored: buildIgnoreMatcher(patterns),
    pathBlind: patterns.length === 0,
  };
  // Keyed by the real path so different spellings of one file (relative vs
  // absolute, `.` segments, case on Windows, symlink aliases) collapse into a
  // single entry; the first spelling seen is the one reported.
  const found = new Map<string, string>();
  const remember = (file: FoundFile): void => {
    const key = canonicalKey(file.real);
    if (!found.has(key)) found.set(key, file.path);
  };

  // The inputs are looked up concurrently, and the walks and the explicitly
  // listed files are then remembered in a fixed order — the walks' finds
  // first, the listed files after them in input order — so which spelling of
  // an aliased file gets reported never depends on filesystem timing.
  const roots = new Array<Directory | undefined>(inputs.length);
  const explicitFiles = new Array<FoundFile | undefined>(inputs.length);
  await Promise.all(
    inputs.map(async (rawInput, index) => {
      if (rawInput === "") {
        // normalize("") would resolve to "." and silently widen the scan.
        throw new Error("empty path is not a valid input");
      }
      const input = normalize(rawInput);
      const info = await withFriendlyNotFound(input, () => stat(input));
      if (info.isDirectory()) {
        // Directory inputs are themselves subject to the ignored directory
        // names and the ignore patterns; only explicitly listed files bypass
        // them.
        if (entersDirectory(context, input, basename(input), input)) {
          roots[index] = { path: input, root: input, above: undefined };
        }
      } else {
        explicitFiles[index] = { path: input, real: await withFriendlyNotFound(input, () => realpath(input)) };
      }
    }),
  );
  await walk(
    roots.filter((root) => root !== undefined),
    context,
    remember,
  );
  for (const file of explicitFiles) {
    if (file !== undefined) remember(file);
  }

  return [...found.values()].sort();
}

/** Identity key of a file: its absolute path, case-folded where the platform compares paths that way. */
function canonicalKey(path: string): string {
  return foldPathCase(resolve(path));
}

/**
 * Folds a path or name the way the platform compares it: Windows paths are
 * case-insensitive (`Foo.ts` and `foo.ts` are one file), everywhere else the
 * spelling is exact.
 */
export function foldPathCase(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

/** Runs the lookup of an explicit input, reporting a missing path under the name the user spelled it with. */
async function withFriendlyNotFound<T>(input: string, lookup: () => Promise<T>): Promise<T> {
  try {
    return await lookup();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`path not found: ${input}`, { cause: error });
    }
    throw error;
  }
}

/**
 * Runs a lookup of the walk, undefined when it fails with an error the walk
 * may step over: entries that vanished mid-walk (ENOENT, ENOTDIR after a
 * directory was replaced) and symlinks that do not resolve (broken targets,
 * ELOOP cycles). Anything else — permissions, I/O failures — propagates, so
 * a partial scan cannot masquerade as a clean one.
 */
async function unlessSkippable<T>(lookup: () => Promise<T>): Promise<T | undefined> {
  try {
    return await lookup();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return undefined;
    throw error;
  }
}

interface WalkContext {
  extensions: string[];
  ignoreDirs: Set<string>;
  isIgnored: IgnoreMatcher;
  /**
   * No ignore pattern is set, so what a walk finds in a directory is the same
   * whatever path led to it: the extensions and the ignored directory names
   * go by the entries' own names. With patterns, a file one spelling excludes
   * can be in scope under another (`--ignore "a-link/*.ts"` and a second link
   * to the same directory).
   */
  pathBlind: boolean;
}

/** A directory a walk is to list, under the path the walk reached it by. */
interface Directory {
  path: string;
  /** Top-level directory this walk started from; ignore globs also match relative to it. */
  root: string;
  /** The real paths of the directories the walk came down through. */
  above: Ancestors | undefined;
}

interface Ancestors {
  real: string;
  above: Ancestors | undefined;
}

/** A file in scope, under the path a walk or an input spelled it with, and its real path. */
interface FoundFile {
  path: string;
  real: string;
}

/** Whether a walk enters the directory: neither its name nor an ignore pattern excludes it. */
function entersDirectory(context: WalkContext, path: string, name: string, root: string): boolean {
  return !context.ignoreDirs.has(foldPathCase(name)) && !context.isIgnored(path, root, true);
}

/**
 * Walks the directories level by level, handing every file in scope to
 * `remember`. A level's lookups run concurrently, but what they find is taken
 * in the order of the level — the roots in input order, the entries below
 * them by name — so the result, and the spelling a file reached by several
 * paths is remembered under, are the same on every run.
 *
 * Symlinks are followed. A directory a walk came down through is not entered
 * again, which ends the cycles. Where no path can change what a directory
 * holds (see WalkContext.pathBlind), a directory already listed under another
 * path is not listed again either; with ignore patterns, every path to it is
 * walked, and the files found twice collapse in `remember`.
 */
async function walk(
  level: readonly Directory[],
  context: WalkContext,
  remember: (file: FoundFile) => void,
  listed: Set<string> = new Set(),
): Promise<void> {
  if (level.length === 0) return;
  const reals = await Promise.all(level.map((directory) => unlessSkippable(() => realpath(directory.path))));
  const entered: Array<[Directory, string]> = [];
  for (const [index, directory] of level.entries()) {
    const real = reals[index];
    if (real === undefined) continue; // the directory vanished mid-walk
    if (context.pathBlind ? listed.has(real) : isAbove(directory.above, real)) continue;
    listed.add(real);
    entered.push([directory, real]);
  }
  const listings = await Promise.all(entered.map(([directory, real]) => list(directory, real, context)));
  const next: Directory[] = [];
  for (const listing of listings) {
    for (const entry of listing) {
      if ("real" in entry) remember(entry);
      else next.push(entry);
    }
  }
  await walk(next, context, remember, listed);
}

/** Whether the real path is among those of the directories a walk came down through. */
function isAbove(ancestors: Ancestors | undefined, real: string): boolean {
  for (let ancestor = ancestors; ancestor !== undefined; ancestor = ancestor.above) {
    if (ancestor.real === real) return true;
  }
  return false;
}

/** The files in scope and the directories to enter among the directory's entries, by name. */
async function list(directory: Directory, real: string, context: WalkContext): Promise<Array<FoundFile | Directory>> {
  const entries = await unlessSkippable(() => readdir(directory.path, { withFileTypes: true }));
  if (entries === undefined) return []; // the directory vanished after it resolved
  const above = { real, above: directory.above };
  const listing = await Promise.all(
    entries
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map(async (entry): Promise<FoundFile | Directory | undefined> => {
        const full = join(directory.path, entry.name);
        let isDirectory = entry.isDirectory();
        let isFile = entry.isFile();
        if (entry.isSymbolicLink()) {
          // Symlinks are followed, matching how explicitly listed inputs are
          // stat()ed.
          const info = await unlessSkippable(() => stat(full));
          if (info === undefined) return undefined; // broken symlink
          isDirectory = info.isDirectory();
          isFile = info.isFile();
        }
        if (isDirectory) {
          return entersDirectory(context, full, entry.name, directory.root)
            ? { path: full, root: directory.root, above }
            : undefined;
        }
        if (
          !isFile ||
          !hasExtension(entry.name, context.extensions) ||
          context.isIgnored(full, directory.root, false)
        ) {
          return undefined;
        }
        // Remembered under its real path, so several symlinks to one target
        // (or a link plus the target itself) count — and get rewritten — once.
        const realFile = await unlessSkippable(() => realpath(full));
        return realFile === undefined ? undefined : { path: full, real: realFile }; // the file vanished mid-walk
      }),
  );
  return listing.filter((entry) => entry !== undefined);
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

interface IgnorePattern {
  glob: string;
  /** The pattern ended in a slash, so it only excludes directories (`dist/`). */
  directoriesOnly: boolean;
}

function parseIgnorePattern(pattern: string): IgnorePattern {
  const glob = pattern.replace(/\/+$/, "");
  if (glob === "") {
    // picomatch would reject it with an internal-sounding error; name the input instead.
    throw new Error(`invalid ignore pattern: ${JSON.stringify(pattern)}`);
  }
  return { glob, directoriesOnly: glob !== pattern };
}

function buildIgnoreMatcher(patterns: string[]): IgnoreMatcher {
  const parsed = patterns.map(parseIgnorePattern);
  if (parsed.length === 0) return () => false;

  const matchesAny = compileGlobs(parsed.filter((pattern) => !pattern.directoriesOnly).map((pattern) => pattern.glob));
  const matchesDirectory = compileGlobs(
    parsed.filter((pattern) => pattern.directoriesOnly).map((pattern) => pattern.glob),
  );
  const match = (path: string, isDirectory: boolean): boolean =>
    matchesAny(path) || (isDirectory && matchesDirectory(path));

  // Anchored patterns like `src/legacy/**` are tried against the path as
  // spelled, relative to the scanned root, and relative to the working
  // directory, so they work regardless of where the scan was started from.
  return (path, root, isDirectory) => {
    const matches = (candidate: string): boolean => match(candidate, isDirectory);
    if (matches(toPosix(path))) return true;
    return relativeMatches(root, path, matches) || relativeMatches(process.cwd(), path, matches);
  };
}

/**
 * One predicate over gitignore-like globs: patterns without a slash match
 * base names, patterns with a slash match whole paths. (picomatch's
 * `basename` option would apply to every pattern, breaking path globs, so
 * the two groups get separate matchers.)
 */
function compileGlobs(globs: string[]): (path: string) => boolean {
  const matchers: Array<(path: string) => boolean> = [];
  const byBasename = globs.filter((glob) => !glob.includes("/"));
  const byPath = globs.filter((glob) => glob.includes("/"));
  if (byBasename.length > 0) matchers.push(picomatch(byBasename, { dot: true, basename: true }));
  if (byPath.length > 0) matchers.push(picomatch(byPath, { dot: true }));
  return (path) => matchers.some((matcher) => matcher(path));
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

// The extensions tsc reads as JavaScript, with types in JSDoc.
const JAVASCRIPT_EXTENSIONS = [".js", ".jsx", ".mjs", ".cjs"];

// TypeScript parses plain JavaScript with the JSX language variant, so `.js`
// belongs here: read as TS instead, `<div>http://x</div>` in a React file
// becomes a type assertion followed by a phantom `//x` comment.
const JSX_EXTENSIONS = [".tsx", ...JAVASCRIPT_EXTENSIONS];

/** True for files whose syntax admits JSX (`.tsx`, `.jsx` and plain JavaScript), case-insensitively. */
export function isJsxFile(file: string): boolean {
  return hasExtension(file, JSX_EXTENSIONS);
}

/** True for JavaScript files (`.js`, `.jsx`, `.mjs`, `.cjs`), case-insensitively. */
export function isJavaScriptFile(file: string): boolean {
  return hasExtension(file, JAVASCRIPT_EXTENSIONS);
}

/** The scan options a file's extension calls for. */
export function scanOptionsFor(file: string): ScanOptions {
  return { jsx: isJsxFile(file), javascript: isJavaScriptFile(file) };
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
  const marked = detectByteOrderMark(data);
  const encoding = marked ?? "utf8";
  const bom = marked !== undefined;
  const body = bom ? data.subarray(BYTE_ORDER_MARKS[encoding].length) : data;
  const text = encoding === "utf16be" ? decodeUtf16Be(body) : body.toString(encoding);
  const lossless = encodeFileText(text, { encoding, bom }).equals(data);
  return { text, encoding, bom, lossless };
}

const BYTE_ORDER_MARKS: Readonly<Record<FileEncoding, Buffer>> = {
  utf8: Buffer.from([0xef, 0xbb, 0xbf]),
  utf16le: Buffer.from([0xff, 0xfe]),
  utf16be: Buffer.from([0xfe, 0xff]),
};

/** The encoding whose byte-order mark opens the data, if any. */
function detectByteOrderMark(data: Buffer): FileEncoding | undefined {
  return (Object.keys(BYTE_ORDER_MARKS) as FileEncoding[]).find((encoding) => {
    const mark = BYTE_ORDER_MARKS[encoding];
    return data.subarray(0, mark.length).equals(mark);
  });
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
    target.encoding === "utf16be" ? Buffer.from(text, "utf16le").swap16() : Buffer.from(text, target.encoding);
  return target.bom ? Buffer.concat([BYTE_ORDER_MARKS[target.encoding], body]) : body;
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
  // Permission bits only: stat()'s mode also carries the file-type bits.
  const permissions = (await stat(target)).mode & 0o7777;
  const temp = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temp, "wx", permissions);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // open()'s mode is filtered through the umask; restore the original exactly.
    await chmod(temp, permissions);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function scanFile(file: string): Promise<FileScanResult> {
  const { text } = await readFileText(file);
  return { file, comments: scanComments(text, scanOptionsFor(file)) };
}

export async function scanPaths(inputs: string[], options: CollectOptions = {}): Promise<FileScanResult[]> {
  return mapFiles(await collectFiles(inputs, options), scanFile);
}

/** How many files are read and processed at once. */
const FILE_CONCURRENCY = 16;

/** Maps the files through `fn`, FILE_CONCURRENCY at a time, with the results in the files' order. */
export function mapFiles<R>(files: readonly string[], fn: (file: string) => Promise<R>): Promise<R[]> {
  return mapLimit(files, FILE_CONCURRENCY, fn);
}

/** Concurrency-limited map that keeps input order and starts work as slots free up. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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
