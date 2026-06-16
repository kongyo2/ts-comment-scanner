import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { scanComments } from "./scanner.js";
import type { FileScanResult } from "./types.js";

const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const DEFAULT_IGNORE_DIRS = ["node_modules", ".git"];
const READ_CONCURRENCY = 16;

export interface CollectOptions {
  extensions?: string[];
  ignoreDirs?: string[];
}

export async function collectFiles(inputs: string[], options: CollectOptions = {}): Promise<string[]> {
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  const ignoreDirs = new Set(options.ignoreDirs ?? DEFAULT_IGNORE_DIRS);
  const found = new Set<string>();

  await Promise.all(
    inputs.map(async (input) => {
      const info = await stat(input);
      if (info.isDirectory()) {
        await walk(input, extensions, ignoreDirs, found);
      } else {
        found.add(input);
      }
    }),
  );

  return [...found].sort();
}

async function walk(dir: string, extensions: string[], ignoreDirs: Set<string>, found: Set<string>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignoreDirs.has(entry.name)) {
          await walk(full, extensions, ignoreDirs, found);
        }
      } else if (entry.isFile() && extensions.includes(extname(entry.name))) {
        found.add(full);
      }
    }),
  );
}

export async function scanFile(file: string): Promise<FileScanResult> {
  const source = await readFile(file, "utf8");
  return { file, comments: scanComments(source) };
}

export async function scanPaths(inputs: string[], options: CollectOptions = {}): Promise<FileScanResult[]> {
  const files = await collectFiles(inputs, options);
  return mapLimit(files, READ_CONCURRENCY, scanFile);
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];

  const processFrom = async (start: number): Promise<void> => {
    if (start >= items.length) return;
    const batch = await Promise.all(items.slice(start, start + limit).map(fn));
    results.push(...batch);
    await processFrom(start + limit);
  };

  await processFrom(0);
  return results;
}
