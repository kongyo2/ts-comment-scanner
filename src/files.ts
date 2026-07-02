import { readFile, readdir, stat } from "node:fs/promises";
import { join, normalize, relative, sep } from "node:path";
import picomatch from "picomatch";
import { scanComments } from "./scanner.js";
import type { FileScanResult } from "./types.js";

const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const DEFAULT_IGNORE_DIRS = ["node_modules", ".git"];

export interface CollectOptions {
  /** File extensions to include (with or without a leading dot, case-insensitive). */
  extensions?: string[];
  /** Directory names that are never traversed. Default: node_modules, .git */
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
  const ignoreDirs = new Set(options.ignoreDirs ?? DEFAULT_IGNORE_DIRS);
  const isIgnored = buildIgnoreMatcher(options.ignore ?? []);
  const found = new Set<string>();

  await Promise.all(
    inputs.map(async (rawInput) => {
      if (rawInput === "") {
        // normalize("") would resolve to "." and silently widen the scan.
        throw new Error("empty path is not a valid input");
      }
      const input = normalize(rawInput);
      const info = await stat(input);
      if (info.isDirectory()) {
        await walk(input, { extensions, ignoreDirs, isIgnored, root: input }, found);
      } else {
        found.add(input);
      }
    }),
  );

  return [...found].sort();
}

interface WalkContext {
  extensions: string[];
  ignoreDirs: Set<string>;
  isIgnored: IgnoreMatcher;
  /** Top-level directory this walk started from; ignore globs also match relative to it. */
  root: string;
}

async function walk(dir: string, context: WalkContext, found: Set<string>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!context.ignoreDirs.has(entry.name) && !context.isIgnored(full, context.root)) {
          await walk(full, context, found);
        }
      } else if (
        entry.isFile() &&
        hasExtension(entry.name, context.extensions) &&
        !context.isIgnored(full, context.root)
      ) {
        found.add(full);
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
  return relativePath !== "" && !relativePath.startsWith("..") && match(toPosix(relativePath));
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

export function isJsxFile(file: string): boolean {
  const lower = file.toLowerCase();
  return lower.endsWith(".tsx") || lower.endsWith(".jsx");
}

export async function scanFile(file: string): Promise<FileScanResult> {
  const raw = await readFile(file, "utf8");
  // Positions are reported relative to the content after a leading byte-order
  // mark, matching editors, GitHub annotations and the removal report.
  const source = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  return { file, comments: scanComments(source, { jsx: isJsxFile(file) }) };
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
