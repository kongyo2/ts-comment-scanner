import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Buffer } from "node:buffer";
import { mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
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
  };
});

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
    vi.mocked(realpath).mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "ENOENT" }));

    expect(await collectFiles([dir])).toEqual([]);
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
