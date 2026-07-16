import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** --name-only output stays tiny even for huge diffs; this is pure headroom. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Absolute paths (symlinks resolved) of the working-tree files touched in a
 * git revision range. The range is anything `git diff` accepts as revisions:
 * a single commit-ish compares the working tree against it (`HEAD` covers all
 * uncommitted work), while `a..b` and `a...b` compare commits. Files deleted
 * in the range are omitted because they have no working-tree content left,
 * and renames are reported at their new path.
 */
export async function changedFiles(range: string, cwd: string = process.cwd()): Promise<string[]> {
  const top = (await git(["rev-parse", "--show-toplevel"], cwd)).replace(/\r?\n$/, "");
  const root = await realpath(top);
  const listing = await git(["diff", "--name-only", "-z", "--no-renames", "--diff-filter=d", range, "--"], cwd);
  return listing
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => resolve(root, entry));
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
