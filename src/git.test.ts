import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { changedFiles } from "./git.js";

const execFileAsync = promisify(execFile);

let dir: string;

async function git(...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: dir });
}

async function initRepo(): Promise<void> {
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await git("config", "commit.gpgsign", "false");
}

async function commitAll(message: string): Promise<void> {
  await git("add", "-A");
  await git("commit", "-q", "-m", message);
}

beforeEach(async () => {
  // realpath so expectations match the resolved paths changedFiles returns
  // (os.tmpdir() goes through a symlink on macOS).
  dir = await realpath(await mkdtemp(join(tmpdir(), "tcs-git-")));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("changedFiles", () => {
  it("lists files changed between two commits as absolute paths", async () => {
    await initRepo();
    await writeFile(join(dir, "a.ts"), "// a\n");
    await commitAll("base");
    await writeFile(join(dir, "a.ts"), "// a2\n");
    await writeFile(join(dir, "b.ts"), "// b\n");
    await commitAll("change");

    const files = await changedFiles("HEAD~1..HEAD", dir);

    expect(files.sort()).toEqual([join(dir, "a.ts"), join(dir, "b.ts")]);
  });

  it("compares the working tree against a single revision", async () => {
    await initRepo();
    await writeFile(join(dir, "a.ts"), "// a\n");
    await writeFile(join(dir, "b.ts"), "// b\n");
    await commitAll("base");
    await writeFile(join(dir, "b.ts"), "// b2\n");

    expect(await changedFiles("HEAD", dir)).toEqual([join(dir, "b.ts")]);
  });

  it("omits files deleted in the range", async () => {
    await initRepo();
    await writeFile(join(dir, "a.ts"), "// a\n");
    await writeFile(join(dir, "b.ts"), "// b\n");
    await commitAll("base");
    await writeFile(join(dir, "a.ts"), "// a2\n");
    await git("rm", "-q", "b.ts");

    expect(await changedFiles("HEAD", dir)).toEqual([join(dir, "a.ts")]);
  });

  it("reports a renamed file at its new path only", async () => {
    await initRepo();
    await writeFile(join(dir, "old.ts"), "// same content\n");
    await commitAll("base");
    await git("mv", "old.ts", "new.ts");
    await commitAll("rename");

    expect(await changedFiles("HEAD~1..HEAD", dir)).toEqual([join(dir, "new.ts")]);
  });

  it("resolves paths against the repository root, not the working directory", async () => {
    await initRepo();
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "c.ts"), "// c\n");
    await commitAll("base");
    await writeFile(join(dir, "sub", "c.ts"), "// c2\n");
    await writeFile(join(dir, "u.ts"), "// untracked at the root\n");

    const files = await changedFiles("HEAD", join(dir, "sub"));

    expect(files.sort()).toEqual([join(dir, "sub", "c.ts"), join(dir, "u.ts")]);
  });

  it("includes untracked files when comparing against the working tree", async () => {
    await initRepo();
    await writeFile(join(dir, "a.ts"), "// a\n");
    await commitAll("base");
    await writeFile(join(dir, "b.ts"), "// new\n");

    expect(await changedFiles("HEAD", dir)).toEqual([join(dir, "b.ts")]);
  });

  it("excludes untracked files from commit-to-commit ranges", async () => {
    await initRepo();
    await writeFile(join(dir, "a.ts"), "// a\n");
    await commitAll("base");
    await writeFile(join(dir, "a.ts"), "// a2\n");
    await commitAll("change");
    await writeFile(join(dir, "b.ts"), "// new\n");

    expect(await changedFiles("HEAD~1..HEAD", dir)).toEqual([join(dir, "a.ts")]);
  });

  it("treats HEAD^! as a commit comparison and adds no untracked files", async () => {
    await initRepo();
    await writeFile(join(dir, "a.ts"), "// a\n");
    await commitAll("base");
    await writeFile(join(dir, "a.ts"), "// a2\n");
    await commitAll("change");
    await writeFile(join(dir, "b.ts"), "// untracked\n");

    expect(await changedFiles("HEAD^!", dir)).toEqual([join(dir, "a.ts")]);
  });

  it("honours .gitignore for untracked files", async () => {
    await initRepo();
    await writeFile(join(dir, ".gitignore"), "ignored.ts\n");
    await commitAll("base");
    await writeFile(join(dir, "ignored.ts"), "// generated\n");
    await writeFile(join(dir, "b.ts"), "// new\n");

    expect(await changedFiles("HEAD", dir)).toEqual([join(dir, "b.ts")]);
  });

  it("reports a changed symlink at its own path, not its target's", async () => {
    await initRepo();
    await writeFile(join(dir, "one.ts"), "// one\n");
    await writeFile(join(dir, "two.ts"), "// two\n");
    await symlink("one.ts", join(dir, "link.ts"));
    await commitAll("base");
    await rm(join(dir, "link.ts"));
    await symlink("two.ts", join(dir, "link.ts"));

    expect(await changedFiles("HEAD", dir)).toEqual([join(dir, "link.ts")]);
  });

  it("rejects a range that could be parsed as a git option", async () => {
    await expect(changedFiles("--output=/tmp/x", dir)).rejects.toThrow(/invalid git revision range/);
    await expect(changedFiles("", dir)).rejects.toThrow(/invalid git revision range/);
  });

  it("rejects an unknown revision with git's error message", async () => {
    await initRepo();
    await writeFile(join(dir, "a.ts"), "// a\n");
    await commitAll("base");

    await expect(changedFiles("no-such-ref", dir)).rejects.toThrow(/git diff failed/);
  });

  it("rejects a directory that is not inside a git repository", async () => {
    await expect(changedFiles("HEAD", dir)).rejects.toThrow(/not a git repository/);
  });
});
