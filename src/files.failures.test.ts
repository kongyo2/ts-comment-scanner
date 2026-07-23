import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Buffer } from "node:buffer";
import { mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFiles, writeFileAtomic } from "./files.js";

// Wrapping the few filesystem calls whose failure paths cannot be provoked on
// a healthy filesystem; everything else passes through to the real module.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: vi.fn(actual.realpath),
    rename: vi.fn(actual.rename),
    rm: vi.fn(actual.rm),
    stat: vi.fn(actual.stat),
  };
});

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: provoked for the test`), { code });
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tcs-fail-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("collectFiles when the filesystem races", () => {
  it("skips a directory that vanishes between listing and walking", async () => {
    await writeFile(join(dir, "a.ts"), "// a\n");
    vi.mocked(realpath).mockRejectedValueOnce(fsError("ENOENT"));

    expect(await collectFiles([dir])).toEqual([]);
  });

  it("skips a file whose path stops being one between listing and resolving", async () => {
    const { realpath: actualRealpath } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await writeFile(join(dir, "a.ts"), "// a\n");
    // The first realpath resolves the walked directory; the second, rejected
    // one is the file's own identity lookup.
    vi.mocked(realpath).mockImplementationOnce(actualRealpath).mockRejectedValueOnce(fsError("ENOTDIR"));

    expect(await collectFiles([dir])).toEqual([]);
  });

  it("reports a friendly error when an explicit file vanishes before resolving", async () => {
    const file = join(dir, "a.ts");
    await writeFile(file, "// a\n");
    vi.mocked(realpath).mockRejectedValueOnce(fsError("ENOENT"));

    await expect(collectFiles([file])).rejects.toThrow(/path not found/);
  });
});

describe("collectFiles when the filesystem fails", () => {
  it("propagates a permission error from resolving a walked directory", async () => {
    await writeFile(join(dir, "a.ts"), "// a\n");
    vi.mocked(realpath).mockRejectedValueOnce(fsError("EACCES"));

    await expect(collectFiles([dir])).rejects.toThrow(/EACCES/);
  });

  it("propagates an I/O error from resolving a walked file", async () => {
    const { realpath: actualRealpath } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await writeFile(join(dir, "a.ts"), "// a\n");
    vi.mocked(realpath).mockImplementationOnce(actualRealpath).mockRejectedValueOnce(fsError("EIO"));

    await expect(collectFiles([dir])).rejects.toThrow(/EIO/);
  });

  it("propagates a permission error from resolving an explicit file", async () => {
    const file = join(dir, "a.ts");
    await writeFile(file, "// a\n");
    vi.mocked(realpath).mockRejectedValueOnce(fsError("EACCES"));

    await expect(collectFiles([file])).rejects.toThrow(/EACCES/);
  });

  it("propagates a permission error from following a symlink instead of skipping it", async () => {
    const { stat: actualStat } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    await writeFile(join(dir, "target.ts"), "// target\n");
    await symlink(join(dir, "target.ts"), join(dir, "link.ts"));
    // The first stat checks the input directory; the second, rejected one is
    // the symlink resolution during the walk (link.ts is the only symlink).
    vi.mocked(stat).mockImplementationOnce(actualStat).mockRejectedValueOnce(fsError("EACCES"));

    await expect(collectFiles([dir])).rejects.toThrow(/EACCES/);
  });
});

describe("writeFileAtomic when the final rename fails", () => {
  it("removes the temporary file and rethrows without touching the target", async () => {
    const file = join(dir, "a.ts");
    await writeFile(file, "old");
    vi.mocked(rename).mockRejectedValueOnce(new Error("rename failed"));

    await expect(writeFileAtomic(file, Buffer.from("new"))).rejects.toThrow("rename failed");

    expect(await readFile(file, "utf8")).toBe("old");
    expect(await readdir(dir)).toEqual(["a.ts"]);
  });

  it("still reports the write error when even the cleanup fails", async () => {
    const file = join(dir, "a.ts");
    await writeFile(file, "old");
    vi.mocked(rename).mockRejectedValueOnce(new Error("rename failed"));
    vi.mocked(rm).mockRejectedValueOnce(new Error("cleanup failed"));

    await expect(writeFileAtomic(file, Buffer.from("new"))).rejects.toThrow("rename failed");

    expect(await readFile(file, "utf8")).toBe("old");
  });
});
