import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseArgs } from "./args.js";
import { removeComments } from "./remove.js";
import { getVersion } from "./version.js";
import { run, type CliIO } from "./run.js";

// Nothing in the real collaborators throws non-Error values or non-usage
// parser errors, so these paths are provoked through wrapped modules.
vi.mock("./args.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./args.js")>();
  return { ...actual, parseArgs: vi.fn(actual.parseArgs) };
});
vi.mock("./version.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./version.js")>();
  return { ...actual, getVersion: vi.fn(actual.getVersion) };
});
vi.mock("./remove.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./remove.js")>();
  return { ...actual, removeComments: vi.fn(actual.removeComments) };
});

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

async function git(...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: dir });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tcs-runfail-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("run when collaborators misbehave", () => {
  it("lets unexpected argument-parser errors escape instead of reporting usage", async () => {
    vi.mocked(parseArgs).mockImplementationOnce(() => {
      throw new TypeError("argv exploded");
    });
    const { io } = capture();

    await expect(run(["src"], io)).rejects.toThrow(TypeError);
  });

  it("stringifies a non-Error failure from the scan pipeline", async () => {
    vi.mocked(getVersion).mockRejectedValueOnce("no version today");
    const { io, err } = capture();

    const code = await run(["--version"], io);

    expect(code).toBe(2);
    expect(err()).toBe("ts-comment-scanner: no version today\n");
  });

  it("stringifies a non-Error removal failure and leaves the file alone", async () => {
    const file = join(dir, "a.ts");
    await writeFile(file, "// note\nconst x = 1;\n");
    vi.mocked(removeComments).mockImplementationOnce(() => {
      throw "removal exploded";
    });
    const { io, err } = capture();

    const code = await run(["--remove", file], io);

    expect(code).toBe(2);
    expect(err()).toContain(`${file}: removal exploded`);
    expect(await readFile(file, "utf8")).toBe("// note\nconst x = 1;\n");
  });

  it("keeps --diff matching when a collected file's directory can no longer be resolved", async () => {
    await git("init", "-q", "-b", "main");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await git("config", "commit.gpgsign", "false");
    await writeFile(join(dir, "a.ts"), "// base\n");
    await git("add", "-A");
    await git("commit", "-q", "-m", "base");
    await writeFile(join(dir, "a.ts"), "// changed\n");
    // A directory vanishing between the walk and the --diff filter must not
    // abort the run: the file is compared as spelled instead.
    const native = realpathSync.native;
    vi.spyOn(realpathSync, "native").mockImplementation((path, options) => {
      if (path === dir) throw Object.assign(new Error("ENOENT: provoked"), { code: "ENOENT" });
      return native(path, options as undefined);
    });
    const { io, out } = capture();

    const code = await run(["--diff", "HEAD", dir], io);

    expect(code).toBe(0);
    expect(out()).toContain("// changed");
  });
});
