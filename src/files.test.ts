import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFiles, isJsxFile, scanFile, scanPaths } from "./files.js";

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

  it("parses .tsx files as JSX so JSX text is not reported as a comment", async () => {
    const file = join(dir, "component.tsx");
    await writeFile(file, "const e = <div>http://example.com</div>;\n");

    const result = await scanFile(file);

    expect(result.comments).toEqual([]);
  });

  it("treats extensions case-insensitively when deciding on JSX parsing", async () => {
    const file = join(dir, "Component.TSX");
    await writeFile(file, "const e = <div>http://example.com</div>;\n");

    const result = await scanFile(file);

    expect(result.comments).toEqual([]);
  });

  it("reports positions relative to the content after a byte-order mark", async () => {
    const file = join(dir, "bom.ts");
    await writeFile(file, "\uFEFF// hi\nconst x = 1;\n");

    const result = await scanFile(file);

    expect(result.comments[0]).toMatchObject({ start: 0, line: 1, column: 1 });
  });
});

describe("isJsxFile", () => {
  it("recognises .tsx and .jsx in any casing", () => {
    expect(isJsxFile("a.tsx")).toBe(true);
    expect(isJsxFile("a.JSX")).toBe(true);
    expect(isJsxFile("a.ts")).toBe(false);
    expect(isJsxFile("a.mts")).toBe(false);
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

  it("matches extensions case-insensitively", async () => {
    await writeFile(join(dir, "UPPER.TS"), "// upper");

    const files = await collectFiles([dir]);

    expect(files).toEqual([join(dir, "UPPER.TS")]);
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

  it("de-duplicates differently spelled paths to the same file", async () => {
    await writeFile(join(dir, "a.ts"), "// a");

    const files = await collectFiles([join(dir, "a.ts"), join(dir, ".", "a.ts")]);

    expect(files).toEqual([join(dir, "a.ts")]);
  });

  it("honours a custom extensions list, with or without dots", async () => {
    await writeFile(join(dir, "a.ts"), "// a");
    await writeFile(join(dir, "b.mjs"), "// b");

    const files = await collectFiles([dir], { extensions: ["mjs"] });

    expect(files).toEqual([join(dir, "b.mjs")]);
  });

  it("matches compound extensions like d.ts as suffixes", async () => {
    await writeFile(join(dir, "types.d.ts"), "// decls");
    await writeFile(join(dir, "code.ts"), "// code");
    await writeFile(join(dir, "unrelated.ts"), "// other");

    const files = await collectFiles([dir], { extensions: ["d.ts"] });

    expect(files).toEqual([join(dir, "types.d.ts")]);
  });

  it("does not let a plain extension lose files with compound suffixes", async () => {
    await writeFile(join(dir, "types.d.ts"), "// decls");
    await writeFile(join(dir, "code.mts"), "// code");

    const files = await collectFiles([dir], { extensions: [".ts"] });

    expect(files).toEqual([join(dir, "types.d.ts")]);
  });

  it("skips files matching an ignore glob by base name", async () => {
    await writeFile(join(dir, "a.ts"), "// a");
    await writeFile(join(dir, "a.test.ts"), "// test");

    const files = await collectFiles([dir], { ignore: ["*.test.ts"] });

    expect(files).toEqual([join(dir, "a.ts")]);
  });

  it("skips files matching a path glob", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "legacy"), { recursive: true });
    await writeFile(join(dir, "src", "a.ts"), "// a");
    await writeFile(join(dir, "legacy", "b.ts"), "// b");

    const files = await collectFiles([dir], { ignore: ["**/legacy/**"] });

    expect(files).toEqual([join(dir, "src", "a.ts")]);
  });

  it("matches path globs relative to the scanned root directory", async () => {
    await mkdir(join(dir, "src", "legacy"), { recursive: true });
    await writeFile(join(dir, "src", "a.ts"), "// a");
    await writeFile(join(dir, "src", "legacy", "b.ts"), "// b");

    const files = await collectFiles([dir], { ignore: ["src/legacy/**"] });

    expect(files).toEqual([join(dir, "src", "a.ts")]);
  });

  it("matches slash-containing globs against the full path, not the base name", async () => {
    await mkdir(join(dir, "legacy"), { recursive: true });
    await writeFile(join(dir, "legacy", "b.ts"), "// b");
    await writeFile(join(dir, "keep.ts"), "// keep");

    const files = await collectFiles([dir], { ignore: ["**/legacy/*.ts"] });

    expect(files).toEqual([join(dir, "keep.ts")]);
  });

  it("combines base-name and path globs in one ignore list", async () => {
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "a.ts"), "// a");
    await writeFile(join(dir, "a.test.ts"), "// test");
    await writeFile(join(dir, "sub", "b.ts"), "// b");

    const files = await collectFiles([dir], { ignore: ["*.test.ts", "**/sub/*.ts"] });

    expect(files).toEqual([join(dir, "a.ts")]);
  });

  it("prunes whole directories matching an ignore pattern", async () => {
    await mkdir(join(dir, "fixtures", "deep"), { recursive: true });
    await writeFile(join(dir, "fixtures", "deep", "x.ts"), "// x");
    await writeFile(join(dir, "top.ts"), "// top");

    const files = await collectFiles([dir], { ignore: ["fixtures"] });

    expect(files).toEqual([join(dir, "top.ts")]);
  });

  it("applies ignore patterns to directories passed as inputs", async () => {
    await mkdir(join(dir, "generated"), { recursive: true });
    await writeFile(join(dir, "generated", "g.ts"), "// g");

    const files = await collectFiles([join(dir, "generated")], { ignore: ["generated"] });

    expect(files).toEqual([]);
  });

  it("rejects an empty input path instead of widening it to the current directory", async () => {
    await expect(collectFiles([""])).rejects.toThrow(/empty path/);
  });

  it("does not apply ignore globs to explicitly listed files", async () => {
    const file = join(dir, "a.test.ts");
    await writeFile(file, "// test");

    const files = await collectFiles([file], { ignore: ["*.test.ts"] });

    expect(files).toEqual([file]);
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

  it("returns results in sorted file order across many files", async () => {
    const names = Array.from({ length: 25 }, (_, index) => `f${String(index).padStart(2, "0")}.ts`);
    await Promise.all(names.map((name) => writeFile(join(dir, name), `// ${name}`)));

    const results = await scanPaths([dir]);

    expect(results.map((result) => result.file)).toEqual(names.map((name) => join(dir, name)));
  });

  it("forwards ignore patterns to file collection", async () => {
    await writeFile(join(dir, "a.ts"), "// a");
    await writeFile(join(dir, "a.test.ts"), "// test");

    const results = await scanPaths([dir], { ignore: ["*.test.ts"] });

    expect(results.map((result) => result.file)).toEqual([join(dir, "a.ts")]);
  });
});
