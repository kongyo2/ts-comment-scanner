import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, normalize, relative, sep } from "node:path";
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

type IgnoreMatcher = (path: string) => boolean;

export async function collectFiles(inputs: string[], options: CollectOptions = {}): Promise<string[]> {
  const extensions = normalizeExtensions(options.extensions ?? DEFAULT_EXTENSIONS);
  const ignoreDirs = new Set(options.ignoreDirs ?? DEFAULT_IGNORE_DIRS);
  const isIgnored = buildIgnoreMatcher(options.ignore ?? []);
  const found = new Set<string>();

  await Promise.all(
    inputs.map(async (rawInput) => {
      const input = normalize(rawInput);
      const info = await stat(input);
      if (info.isDirectory()) {
        await walk(input, { extensions, ignoreDirs, isIgnored }, found);
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
}

async function walk(dir: string, context: WalkContext, found: Set<string>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!context.ignoreDirs.has(entry.name) && !context.isIgnored(full)) {
          await walk(full, context, found);
        }
      } else if (
        entry.isFile() &&
        context.extensions.includes(extname(entry.name).toLowerCase()) &&
        !context.isIgnored(full)
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

  return (path) => {
    if (match(toPosix(path))) return true;
    // Also try the path relative to the working directory, so patterns like
    // `src/legacy/**` work no matter how the input path was spelled.
    const fromCwd = relative(process.cwd(), path);
    return fromCwd !== "" && !fromCwd.startsWith("..") && match(toPosix(fromCwd));
  };
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

export function isJsxFile(file: string): boolean {
  const lower = file.toLowerCase();
  return lower.endsWith(".tsx") || lower.endsWith(".jsx");
}

export async function scanFile(file: string): Promise<FileScanResult> {
  const source = await readFile(file, "utf8");
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
