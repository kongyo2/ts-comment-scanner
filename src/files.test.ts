import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFiles, scanFile, scanPaths } from "./files.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tcs-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("scanFile", () => {
  it("reads a file and returns its path with detected comments", async () => {
    const file = join(dir, "a.ts");
    await writeFile(file, "const x = 1; // hi");

    const result = await scanFile(file);

    expect(result.file).toBe(file);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]).toMatchObject({ kind: "line", text: "// hi" });
  });
});

describe("collectFiles", () => {
  it("expands a directory to the TypeScript files it contains", async () => {
    await writeFile(join(dir, "a.ts"), "// a");
    await writeFile(join(dir, "b.ts"), "// b");

    const files = await collectFiles([dir]);

    expect(files).toEqual([join(dir, "a.ts"), join(dir, "b.ts")]);
  });

  it("returns an explicitly passed file regardless of extension", async () => {
    const file = join(dir, "notes.md");
    await writeFile(file, "// not really ts");

    const files = await collectFiles([file]);

    expect(files).toEqual([file]);
  });

  it("recurses into subdirectories", async () => {
    await mkdir(join(dir, "nested"), { recursive: true });
    await writeFile(join(dir, "top.ts"), "// top");
    await writeFile(join(dir, "nested", "deep.ts"), "// deep");

    const files = await collectFiles([dir]);

    expect(files).toEqual([join(dir, "nested", "deep.ts"), join(dir, "top.ts")]);
  });

  it("ignores files with non-TypeScript extensions in a directory", async () => {
    await writeFile(join(dir, "keep.ts"), "// keep");
    await writeFile(join(dir, "skip.json"), "{}");
    await writeFile(join(dir, "readme.md"), "# hi");

    const files = await collectFiles([dir]);

    expect(files).toEqual([join(dir, "keep.ts")]);
  });

  it("skips node_modules directories", async () => {
    await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "node_modules", "pkg", "ignored.ts"), "// ignored");
    await writeFile(join(dir, "src", "kept.ts"), "// kept");

    const files = await collectFiles([dir]);

    expect(files).toEqual([join(dir, "src", "kept.ts")]);
  });

  it("returns sorted, de-duplicated paths", async () => {
    await writeFile(join(dir, "b.ts"), "// b");
    await writeFile(join(dir, "a.ts"), "// a");

    const files = await collectFiles([dir, dir]);

    expect(files).toEqual([join(dir, "a.ts"), join(dir, "b.ts")]);
  });
});

describe("scanPaths", () => {
  it("scans every collected file", async () => {
    await writeFile(join(dir, "a.ts"), "// a");
    await writeFile(join(dir, "b.ts"), "const x = 1;");

    const results = await scanPaths([dir]);

    expect(results).toEqual([
      { file: join(dir, "a.ts"), comments: [expect.objectContaining({ text: "// a" })] },
      { file: join(dir, "b.ts"), comments: [] },
    ]);
  });
});
