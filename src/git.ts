import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** --name-only output stays tiny even for huge diffs; this is pure headroom. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Absolute paths of the working-tree files touched in a git revision range.
 * The range is anything `git diff` accepts as revisions: a single commit-ish
 * compares the working tree against it (`HEAD` covers all uncommitted work,
 * untracked files included), while `a..b` and `a...b` compare commits. Files
 * deleted in the range are omitted because they have no working-tree content
 * left, and renames are reported at their new path.
 */
export async function changedFiles(range: string, cwd: string = process.cwd()): Promise<string[]> {
  if (range === "" || range.startsWith("-")) {
    // Never let the range reach git where it could parse as an option (--output=...).
    throw new Error(`invalid git revision range: ${JSON.stringify(range)}`);
  }
  const top = (await git(["rev-parse", "--show-toplevel"], cwd)).replace(/\r?\n$/, "");
  const root = await realpath(top);
  // --no-relative pins root-relative output even under diff.relative=true.
  const args = ["diff", "--name-only", "-z", "--no-renames", "--no-relative", "--diff-filter=d", range, "--"];
  const entries = split(await git(args, cwd));
  // A working-tree comparison treats brand-new files as changes too, yet
  // `git diff` never lists them. Runs at the root so the whole repository is
  // covered regardless of cwd; .gitignore still applies.
  if (await comparesWorkingTree(range, cwd)) {
    entries.push(...split(await git(["ls-files", "--others", "--exclude-standard", "--full-name", "-z"], root)));
  }
  return [...new Set(entries)].map((entry) => resolve(root, entry));
}

/**
 * `git diff` compares the working tree only against a lone positive revision;
 * every other shape (`a..b`, `a...b`, `HEAD^!`, multi-parent `HEAD^@`)
 * compares commits. String sniffing cannot tell these apart — `HEAD^!`
 * contains no ".." yet excludes the working tree — so ask rev-parse for the
 * expansion and check for exactly one non-negated revision.
 */
async function comparesWorkingTree(range: string, cwd: string): Promise<boolean> {
  const revs = (await git(["rev-parse", "--revs-only", range, "--"], cwd)).split("\n").filter((line) => line !== "");
  return revs.length === 1 && !(revs[0] as string).startsWith("^");
}

function split(listing: string): string[] {
  return listing.split("\0").filter((entry) => entry !== "");
}

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: MAX_OUTPUT_BYTES });
    return stdout;
  } catch (error) {
    throw new Error(describeFailure(args[0] as string, error), { cause: error });
  }
}

function describeFailure(subcommand: string, error: unknown): string {
  const failure = error as { code?: unknown; stderr?: unknown; message?: unknown };
  if (failure.code === "ENOENT") {
    return "git executable not found (is git installed and on PATH?)";
  }
  const stderr = typeof failure.stderr === "string" ? failure.stderr.trim() : "";
  const newline = stderr.indexOf("\n");
  const detail = stderr === "" ? String(failure.message ?? error) : newline === -1 ? stderr : stderr.slice(0, newline);
  return `git ${subcommand} failed: ${detail}`;
}
