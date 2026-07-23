import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs, UsageError, type CliOptions, type DirectiveMode } from "./args.js";
import {
  collectFiles,
  encodeFileText,
  isJsxFile,
  mapLimit,
  readFileText,
  scanFile,
  writeFileAtomic,
  FILE_CONCURRENCY,
  type CollectOptions,
} from "./files.js";
import { changedFiles } from "./git.js";
import { removeComments } from "./remove.js";
import { count, formatGitHub, formatJson, formatText } from "./report.js";
import { getVersion } from "./version.js";
import type { Comment, FileScanResult } from "./types.js";

export interface CliIO {
  out: (text: string) => void;
  err: (text: string) => void;
}

export const HELP_TEXT = `Usage: ts-comment-scanner [options] [paths...]

Detect, report and clean up comments across a TypeScript project.

Output:
  --format <fmt>       Output format: text, json or github (default: text)
  --json               Shorthand for --format json

Filtering:
  --ignore <glob>      Skip files/directories matching the glob (repeatable)
  --ext <list>         Comma-separated extensions to scan (default: .ts,.tsx,.mts,.cts)
  --diff <range>       Only files git reports changed in the revision range
  --skip-directives    Hide compiler/linter directives (@ts-ignore, eslint-disable, ...)
  --only-directives    Report only compiler/linter directives

CI:
  --fail-on-comment    Exit with code 1 when any comment is reported

Removal:
  --remove             Delete the reported comments from the files (in place)
  --dry-run            With --remove: show what would be removed, change nothing
  --remove-directives  With --remove: also delete directive comments
  --remove-legal       With --remove: also delete license/legal comments

General:
  -h, --help           Show this help
  -v, --version        Print the version number

Paths default to the current directory. Directories are scanned recursively,
skipping node_modules and .git. Removal keeps directives and license headers
unless explicitly requested, so builds and linters keep working.

--diff narrows any scan or removal to files changed in git: a single revision
compares the working tree against it (HEAD covers all uncommitted work,
untracked files included), while main..HEAD compares two commits. Handy for
cleaning up only the files a coding agent just touched.

Exit codes: 0 success, 1 comments reported with --fail-on-comment, 2 error.

Examples:
  ts-comment-scanner src
  ts-comment-scanner --format github --fail-on-comment src
  ts-comment-scanner --ignore "**/*.test.ts" --skip-directives src
  ts-comment-scanner --remove --dry-run src
  ts-comment-scanner --remove --diff main..HEAD
`;

export async function run(argv: string[], io: CliIO): Promise<number> {
  // Help always wins, even on an otherwise-invalid command line.
  if (wantsHelp(argv)) {
    io.out(HELP_TEXT);
    return 0;
  }

  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`ts-comment-scanner: ${error.message}\nTry 'ts-comment-scanner --help' for usage.\n`);
      return 2;
    }
    throw error;
  }

  // A -h/--help the early scan above could not see (e.g. consumed-looking
  // spots like `--ignore -- --help`) still means help once parsed as a flag.
  if (options.help) {
    io.out(HELP_TEXT);
    return 0;
  }

  try {
    if (options.version) {
      io.out(`${await getVersion()}\n`);
      return 0;
    }

    const collectOptions: CollectOptions = {
      ignore: options.ignore,
      ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
    };

    if (options.remove) {
      return await runRemove(options, collectOptions, io);
    }

    const files = await collectTargets(options, collectOptions);
    const results = filterDirectives(await mapLimit(files, FILE_CONCURRENCY, scanFile), options.directives);
    io.out(`${render(results, options.format)}\n`);

    const total = results.reduce((sum, result) => sum + result.comments.length, 0);
    return options.failOnComment && total > 0 ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.err(`ts-comment-scanner: ${message}\n`);
    return 2;
  }
}

/**
 * Collects the input files, narrowed to the files git reports changed when
 * --diff is set. git runs in the repository containing the first input path
 * (not the collected files, which could sit in a nested repository), so
 * scanning another repository's checkout works from anywhere.
 */
async function collectTargets(options: CliOptions, collectOptions: CollectOptions): Promise<string[]> {
  const files = await collectFiles(options.paths, collectOptions);
  if (options.diff === undefined) return files;

  const first = resolve(options.paths[0] as string);
  const anchor = (await stat(first)).isDirectory() ? first : dirname(first);
  const changed = new Set((await changedFiles(options.diff, anchor)).map(caseFold));
  // Realpath only the directory part: spellings through symlinked directories
  // then compare equal, while a tracked symlink still matches the path git
  // reports it at instead of dereferencing to its target. The native variant,
  // because changedFiles resolves the repository root with the (native)
  // promises realpath — on Windows only the native calls expand 8.3 short
  // names like RUNNER~1, and both sides must expand them the same way.
  return files.filter((file) => changed.has(caseFold(join(realpathSync.native(dirname(file)), basename(file)))));
}

/**
 * Windows paths are case-insensitive, but git reports the case a file was
 * tracked with; folding both sides keeps `Foo.ts` in the --diff scope when
 * the scan found it as `foo.ts`.
 */
function caseFold(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

/** True when -h/--help appears before any `--` separator. */
function wantsHelp(argv: string[]): boolean {
  for (const arg of argv) {
    if (arg === "--") return false;
    if (arg === "-h" || arg === "--help") return true;
  }
  return false;
}

function render(results: FileScanResult[], format: CliOptions["format"]): string {
  if (format === "json") return formatJson(results);
  if (format === "github") return formatGitHub(results);
  return formatText(results);
}

function inScope(comment: Comment, mode: DirectiveMode): boolean {
  if (mode === "skip") return comment.directive === undefined;
  if (mode === "only") return comment.directive !== undefined;
  return true;
}

function filterDirectives(results: FileScanResult[], mode: DirectiveMode): FileScanResult[] {
  if (mode === "include") return results;
  return results.map((result) => ({
    file: result.file,
    comments: result.comments.filter((comment) => inScope(comment, mode)),
  }));
}

interface FileRemoval {
  file: string;
  removed: Comment[];
  kept: Comment[];
  skipped: Comment[];
}

async function runRemove(options: CliOptions, collectOptions: CollectOptions, io: CliIO): Promise<number> {
  const files = await collectTargets(options, collectOptions);

  const outcomes = await mapLimit(files, FILE_CONCURRENCY, async (file) => {
    try {
      const { text, encoding, bom, lossless } = await readFileText(file);
      const result = removeComments(text, {
        jsx: isJsxFile(file),
        removeDirectives: options.removeDirectives,
        removeLegal: options.removeLegal,
        shouldRemove: (comment) => inScope(comment, options.directives),
      });
      if (result.changed) {
        if (!lossless) {
          // Re-encoding would not reproduce the original bytes (invalid
          // UTF-8, truncated UTF-16, ...): rewriting the file would corrupt
          // content outside the comments. Reported for --dry-run too, so the
          // preflight fails the same way the real removal would.
          throw new Error("file is not valid UTF-8 or UTF-16; refusing to modify it");
        }
        if (!options.dryRun) {
          await writeFileAtomic(file, encodeFileText(result.code, { encoding, bom }));
        }
      }
      return { file, removed: result.removed, kept: result.kept, skipped: result.skipped };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { file, failure: `${file}: ${message}` };
    }
  });

  const removals: FileRemoval[] = [];
  const failures: string[] = [];
  for (const outcome of outcomes) {
    if ("failure" in outcome) {
      failures.push(outcome.failure);
    } else if (outcome.removed.length > 0 || outcome.kept.length > 0 || outcome.skipped.length > 0) {
      removals.push(outcome);
    }
  }

  io.out(`${renderRemoval(removals, options)}\n`);
  for (const failure of failures) {
    io.err(`ts-comment-scanner: ${failure}\n`);
  }
  return failures.length > 0 ? 2 : 0;
}

function renderRemoval(removals: FileRemoval[], options: CliOptions): string {
  const totalRemoved = removals.reduce((sum, entry) => sum + entry.removed.length, 0);
  const totalKept = removals.reduce((sum, entry) => sum + entry.kept.length, 0);
  const totalSkipped = removals.reduce((sum, entry) => sum + entry.skipped.length, 0);
  const changedEntries = removals.filter((entry) => entry.removed.length > 0);
  const keptNote = totalKept > 0 ? ` Kept ${count(totalKept, "protected comment")}.` : "";
  // Comments held out of scope by --skip-directives / --only-directives are
  // invisible in the removal counts; say how many were left untouched, naming
  // the flag actually responsible, so "removed N" is not mistaken for "the
  // files are now comment-free".
  const skippedReason = options.directives === "only" ? "outside --only-directives" : "--skip-directives";
  const skippedNote = totalSkipped > 0 ? ` Skipped ${count(totalSkipped, "comment")} (${skippedReason}).` : "";

  if (options.format === "json") {
    return JSON.stringify(
      {
        summary: {
          // `files` counts the entries of `files` below, like the scan JSON;
          // `changedFiles` is how many of them actually had comments removed.
          files: removals.length,
          changedFiles: changedEntries.length,
          removed: totalRemoved,
          kept: totalKept,
          skipped: totalSkipped,
          dryRun: options.dryRun,
        },
        files: removals,
      },
      null,
      2,
    );
  }

  if (totalRemoved === 0) {
    return `No removable comments found.${keptNote}${skippedNote}`;
  }

  const verb = options.dryRun ? "would remove" : "removed";
  const lines = changedEntries.map((entry) => {
    const kept = entry.kept.length > 0 ? ` (kept ${entry.kept.length})` : "";
    return `${entry.file}: ${verb} ${entry.removed.length}${kept}`;
  });

  const sentenceVerb = verb.charAt(0).toUpperCase() + verb.slice(1);
  lines.push(
    "",
    `${sentenceVerb} ${count(totalRemoved, "comment")} across ${count(changedEntries.length, "file")}.${keptNote}${skippedNote}`,
  );
  return lines.join("\n");
}
