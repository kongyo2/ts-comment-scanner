import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile, rm, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { run, type CliIO } from "./run.js";

const execFileAsync = promisify(execFile);

let dir: string;

function capture(): { io: CliIO; out: () => string; err: () => string } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: { out: (text) => outChunks.push(text), err: (text) => errChunks.push(text) },
    out: () => outChunks.join(""),
    err: () => errChunks.join(""),
  };
}

async function git(args: string[], cwd = dir): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function initRepo(cwd = dir): Promise<void> {
  await git(["init", "-q", "-b", "main"], cwd);
  await git(["config", "user.email", "test@example.com"], cwd);
  await git(["config", "user.name", "Test"], cwd);
  await git(["config", "commit.gpgsign", "false"], cwd);
}

async function commitAll(message: string, cwd = dir): Promise<void> {
  await git(["add", "-A"], cwd);
  await git(["commit", "-q", "-m", message], cwd);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tcs-run-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("run", () => {
  it("writes the text report and returns 0", async () => {
    await writeFile(join(dir, "a.ts"), "// hi");
    const { io, out, err } = capture();

    const code = await run([dir], io);

    expect(code).toBe(0);
    expect(out()).toContain(`${join(dir, "a.ts")}:1:1 [line] // hi`);
    expect(err()).toBe("");
  });

  it("writes JSON when --json is set", async () => {
    await writeFile(join(dir, "a.ts"), "// hi");
    const { io, out } = capture();

    const code = await run(["--json", dir], io);

    expect(code).toBe(0);
    expect(JSON.parse(out())).toMatchObject({ summary: { comments: 1 } });
  });

  it("writes GitHub annotations when --format github is set", async () => {
    await writeFile(join(dir, "a.ts"), "// hi");
    const { io, out } = capture();

    const code = await run(["--format", "github", dir], io);

    // The file property is escaped like the formatter escapes it (`:` →
    // %3A, ...), so the expectation also holds for Windows drive letters.
    const file = join(dir, "a.ts").replaceAll("%", "%25").replaceAll(":", "%3A").replaceAll(",", "%2C");
    expect(code).toBe(0);
    expect(out()).toContain(`::notice file=${file},line=1,endLine=1,col=1,endColumn=5,title=line comment::// hi`);
  });

  it("prints help and returns 0 without scanning", async () => {
    const { io, out } = capture();

    const code = await run(["--help"], io);

    expect(code).toBe(0);
    expect(out()).toContain("Usage: ts-comment-scanner");
  });

  it("prints help even when the rest of the command line is invalid", async () => {
    const { io, out, err } = capture();

    const code = await run(["--help", "--dry-run"], io);

    expect(code).toBe(0);
    expect(out()).toContain("Usage: ts-comment-scanner");
    expect(err()).toBe("");
  });

  it("treats --help after -- as a path, not a request for help", async () => {
    const { io, err } = capture();

    const code = await run(["--", "--help"], io);

    expect(code).toBe(2);
    expect(err()).toContain("--help");
  });

  it("prints the version and returns 0", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    const { io, out } = capture();

    const code = await run(["--version"], io);

    expect(code).toBe(0);
    expect(out().trim()).toBe(pkg.version);
  });

  it("returns 2 and writes an error when a path does not exist", async () => {
    const { io, err } = capture();

    const code = await run([join(dir, "missing.ts")], io);

    expect(code).toBe(2);
    expect(err()).toContain("missing.ts");
  });

  it("returns 2 for an explicitly empty path argument", async () => {
    const { io, err } = capture();

    const code = await run([""], io);

    expect(code).toBe(2);
    expect(err()).toContain("empty path");
  });

  it("returns 2 and suggests --help for an unknown option", async () => {
    const { io, err } = capture();

    const code = await run(["--jsno"], io);

    expect(code).toBe(2);
    expect(err()).toContain("unknown option: --jsno");
    expect(err()).toContain("--help");
  });

  it("applies ignore patterns from the command line", async () => {
    await writeFile(join(dir, "a.ts"), "// a");
    await writeFile(join(dir, "a.test.ts"), "// test");
    const { io, out } = capture();

    const code = await run(["--ignore", "*.test.ts", dir], io);

    expect(code).toBe(0);
    expect(out()).toContain("a.ts:1:1");
    expect(out()).not.toContain("a.test.ts");
  });

  it("filters directives with --skip-directives", async () => {
    await writeFile(join(dir, "a.ts"), "// @ts-nocheck\n// note\nconst x = 1;\n");
    const { io, out } = capture();

    const code = await run(["--skip-directives", dir], io);

    expect(code).toBe(0);
    expect(out()).toContain("// note");
    expect(out()).not.toContain("@ts-nocheck");
  });

  it("reports only directives with --only-directives", async () => {
    await writeFile(join(dir, "a.ts"), "// @ts-nocheck\n// note\nconst x = 1;\n");
    const { io, out } = capture();

    const code = await run(["--only-directives", dir], io);

    expect(code).toBe(0);
    expect(out()).toContain("@ts-nocheck");
    expect(out()).not.toContain("// note");
  });

  it("returns 1 with --fail-on-comment when comments are found", async () => {
    await writeFile(join(dir, "a.ts"), "// hi");
    const { io } = capture();

    expect(await run(["--fail-on-comment", dir], io)).toBe(1);
  });

  it("returns 0 with --fail-on-comment when the tree is clean", async () => {
    await writeFile(join(dir, "a.ts"), "const x = 1;");
    const { io } = capture();

    expect(await run(["--fail-on-comment", dir], io)).toBe(0);
  });

  it("removes comments in place with --remove", async () => {
    const file = join(dir, "a.ts");
    await writeFile(file, "// gone\nconst x = 1; // also gone\n");
    const { io, out } = capture();

    const code = await run(["--remove", dir], io);

    expect(code).toBe(0);
    expect(await readFile(file, "utf8")).toBe("const x = 1;\n");
    expect(out()).toContain("Removed 2 comments across 1 file.");
  });

  it("keeps directives when removing and reports them as kept", async () => {
    const file = join(dir, "a.ts");
    await writeFile(file, "// @ts-expect-error\nconst x: number = null;\n// gone\n");
    const { io, out } = capture();

    const code = await run(["--remove", dir], io);

    expect(code).toBe(0);
    expect(await readFile(file, "utf8")).toBe("// @ts-expect-error\nconst x: number = null;\n");
    expect(out()).toContain("Kept 1 protected comment.");
  });

  it("does not modify files with --remove --dry-run", async () => {
    const file = join(dir, "a.ts");
    const source = "// gone\nconst x = 1;\n";
    await writeFile(file, source);
    const { io, out } = capture();

    const code = await run(["--remove", "--dry-run", dir], io);

    expect(code).toBe(0);
    expect(await readFile(file, "utf8")).toBe(source);
    expect(out()).toContain("Would remove 1 comment across 1 file.");
  });

  it("emits a JSON removal report with --remove --json", async () => {
    const file = join(dir, "a.ts");
    await writeFile(file, "// gone\nconst x = 1;\n");
    const { io, out } = capture();

    const code = await run(["--remove", "--json", dir], io);

    expect(code).toBe(0);
    expect(JSON.parse(out())).toMatchObject({
      summary: { files: 1, removed: 1, kept: 0, dryRun: false },
    });
  });

  it("reports that there was nothing to remove", async () => {
    await writeFile(join(dir, "a.ts"), "const x = 1;\n");
    const { io, out } = capture();

    const code = await run(["--remove", dir], io);

    expect(code).toBe(0);
    expect(out()).toContain("No removable comments found.");
  });

  it("limits the scan to files changed in the --diff range", async () => {
    await initRepo();
    await writeFile(join(dir, "old.ts"), "// old\n");
    await commitAll("base");
    await writeFile(join(dir, "new.ts"), "// new\n");
    await commitAll("feature");
    const { io, out } = capture();

    const code = await run(["--diff", "HEAD~1..HEAD", dir], io);

    expect(code).toBe(0);
    expect(out()).toContain("new.ts:1:1");
    expect(out()).not.toContain("old.ts");
  });

  it("limits --remove to files changed in the --diff range", async () => {
    await initRepo();
    const untouched = join(dir, "untouched.ts");
    const edited = join(dir, "edited.ts");
    await writeFile(untouched, "// stays\n");
    await writeFile(edited, "const x = 1;\n");
    await commitAll("base");
    await writeFile(edited, "const x = 1; // gone\n");
    const { io, out } = capture();

    const code = await run(["--remove", "--diff", "HEAD", dir], io);

    expect(code).toBe(0);
    expect(await readFile(edited, "utf8")).toBe("const x = 1;\n");
    expect(await readFile(untouched, "utf8")).toBe("// stays\n");
    expect(out()).toContain("Removed 1 comment across 1 file.");
  });

  it("reports no comments when the --diff range changed nothing", async () => {
    await initRepo();
    await writeFile(join(dir, "a.ts"), "// hi\n");
    await commitAll("base");
    const { io, out } = capture();

    const code = await run(["--diff", "HEAD", dir], io);

    expect(code).toBe(0);
    expect(out()).toContain("No comments found.");
  });

  it("returns 2 when --diff gets an unknown revision", async () => {
    await initRepo();
    await writeFile(join(dir, "a.ts"), "// hi\n");
    await commitAll("base");
    const { io, err } = capture();

    const code = await run(["--diff", "no-such-ref", dir], io);

    expect(code).toBe(2);
    expect(err()).toContain("git diff failed");
  });

  it("returns 2 when --diff is used outside a git repository", async () => {
    await writeFile(join(dir, "a.ts"), "// hi\n");
    const { io, err } = capture();

    const code = await run(["--diff", "HEAD", dir], io);

    expect(code).toBe(2);
    expect(err()).toContain("not a git repository");
  });

  it("includes files created but never committed with --diff HEAD", async () => {
    await initRepo();
    await writeFile(join(dir, "old.ts"), "// old\n");
    await commitAll("base");
    await writeFile(join(dir, "fresh.ts"), "// fresh\n");
    const { io, out } = capture();

    const code = await run(["--diff", "HEAD", dir], io);

    expect(code).toBe(0);
    expect(out()).toContain("fresh.ts:1:1");
    expect(out()).not.toContain("old.ts");
  });

  it("returns 2 for an invalid --diff revision even when no files were collected", async () => {
    await initRepo();
    const { io, err } = capture();

    const code = await run(["--diff", "no-such-ref", dir], io);

    expect(code).toBe(2);
    expect(err()).toContain("git diff failed");
  });

  it("returns 2 with --diff in an empty directory outside a git repository", async () => {
    const { io, err } = capture();

    const code = await run(["--diff", "HEAD", dir], io);

    expect(code).toBe(2);
    expect(err()).toContain("not a git repository");
  });

  it("keeps a re-pointed symlink in the --diff scope when passed explicitly", async () => {
    await initRepo();
    await writeFile(join(dir, "one.ts"), "// one\n");
    await writeFile(join(dir, "two.ts"), "// two\n");
    await symlink("one.ts", join(dir, "link.ts"));
    await commitAll("base");
    await rm(join(dir, "link.ts"));
    await symlink("two.ts", join(dir, "link.ts"));
    const { io, out } = capture();

    const code = await run(["--diff", "HEAD", join(dir, "link.ts")], io);

    expect(code).toBe(0);
    expect(out()).toContain(`${join(dir, "link.ts")}:1:1 [line] // two`);
  });

  it("anchors --diff on the input path, not on a nested repository's files", async () => {
    const nested = join(dir, "repo");
    await mkdir(nested);
    await initRepo(nested);
    await writeFile(join(nested, "a.ts"), "// hi\n");
    await commitAll("base", nested);
    const { io, err } = capture();

    const code = await run(["--diff", "HEAD", dir], io);

    expect(code).toBe(2);
    expect(err()).toContain("not a git repository");
  });
});

describe("run regression fixes", () => {
  it("prints help when --help hides behind an option that consumed --", async () => {
    const { io, out } = capture();

    const code = await run(["--ignore", "--", "--help", "--ext", ".zzz", "."], io);

    expect(code).toBe(0);
    expect(out()).toContain("Usage: ts-comment-scanner");
  });

  it("removes comments from a UTF-16LE file and keeps its encoding", async () => {
    const file = join(dir, "a.ts");
    const encode = (text: string): Buffer => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    await writeFile(file, encode("// gone\nconst x = 1;\n"));
    const { io } = capture();

    const code = await run(["--remove", file], io);

    expect(code).toBe(0);
    expect((await readFile(file)).equals(encode("const x = 1;\n"))).toBe(true);
  });

  it("refuses to rewrite a file that is not valid UTF-8", async () => {
    const file = join(dir, "a.ts");
    const original = Buffer.concat([
      Buffer.from('// gone\nconst s = "', "utf8"),
      Buffer.from([0x80]),
      Buffer.from('";\n', "utf8"),
    ]);
    await writeFile(file, original);
    const { io, err } = capture();

    const code = await run(["--remove", file], io);

    expect(code).toBe(2);
    expect(err()).toContain("not valid UTF-8");
    expect((await readFile(file)).equals(original)).toBe(true);
  });

  it("reports the same encoding failure during --remove --dry-run", async () => {
    // The dry run is the preflight for the real removal, so a file the real
    // run would refuse to modify must fail the dry run too.
    const file = join(dir, "a.ts");
    const original = Buffer.concat([
      Buffer.from('// gone\nconst s = "', "utf8"),
      Buffer.from([0x80]),
      Buffer.from('";\n', "utf8"),
    ]);
    await writeFile(file, original);
    const { io, err } = capture();

    const code = await run(["--remove", "--dry-run", file], io);

    expect(code).toBe(2);
    expect(err()).toContain("not valid UTF-8");
    expect((await readFile(file)).equals(original)).toBe(true);
  });

  it("reports how many directives --skip-directives left untouched", async () => {
    const file = join(dir, "a.ts");
    await writeFile(file, "// @ts-nocheck\n// gone\nconst x = 1;\n");
    const { io, out } = capture();

    const code = await run(["--remove", "--skip-directives", dir], io);

    expect(code).toBe(0);
    expect(out()).toContain("Removed 1 comment across 1 file.");
    expect(out()).toContain("Skipped 1 comment (--skip-directives).");
  });

  it("counts skipped directives in the JSON removal summary", async () => {
    const file = join(dir, "a.ts");
    await writeFile(file, "// @ts-nocheck\n// gone\nconst x = 1;\n");
    const { io, out } = capture();

    const code = await run(["--remove", "--skip-directives", "--json", dir], io);

    expect(code).toBe(0);
    expect(JSON.parse(out())).toMatchObject({
      summary: { files: 1, removed: 1, kept: 0, skipped: 1, dryRun: false },
    });
  });

  it("scans files reached through directory symlinks", async () => {
    const real = join(dir, "real");
    const scan = join(dir, "scan");
    await mkdir(real);
    await mkdir(scan);
    await writeFile(join(real, "source.ts"), "// linked comment\n");
    await symlink(real, join(scan, "linked"));
    const { io, out } = capture();

    const code = await run([scan], io);

    expect(code).toBe(0);
    expect(out()).toContain(`${join(scan, "linked", "source.ts")}:1:1 [line] // linked comment`);
  });

  it("reports a friendly error for a missing path", async () => {
    const { io, err } = capture();

    const code = await run([join(dir, "missing.ts")], io);

    expect(code).toBe(2);
    expect(err()).toContain("path not found");
  });
});
