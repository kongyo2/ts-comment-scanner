import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Git picks its repository from these before it looks at the working
// directory, and a git hook exports some of them (GIT_DIR, GIT_INDEX_FILE)
// into everything it runs. Inherited, they would point `git init`, `add -A`
// and `commit` at the caller's checkout instead of the temporary fixture.
// Only the repository-location selectors git documents are dropped; identity,
// configuration and PATH settings pass through untouched.
const REPOSITORY_LOCATION_VARIABLES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
];

/** A copy of the environment in which git resolves its repository from `cwd` alone. */
function isolatedEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of REPOSITORY_LOCATION_VARIABLES) delete env[name];
  return env;
}

/** Runs a git command in the directory; a non-zero exit rejects with git's stderr. */
export async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, env: isolatedEnvironment() });
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
