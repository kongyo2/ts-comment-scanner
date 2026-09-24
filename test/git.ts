import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Runs a git command in the directory; a non-zero exit rejects with git's stderr. */
export async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

/**
 * Turns the directory into a repository on a `main` branch, with the identity
 * and signing settings commits need on a bare CI runner.
 */
export async function initRepo(cwd: string): Promise<void> {
  await git(cwd, "init", "-q", "-b", "main");
  await git(cwd, "config", "user.email", "test@example.com");
  await git(cwd, "config", "user.name", "Test");
  await git(cwd, "config", "commit.gpgsign", "false");
}

/** Stages every change in the repository and commits it. */
export async function commitAll(cwd: string, message: string): Promise<void> {
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-q", "-m", message);
}
