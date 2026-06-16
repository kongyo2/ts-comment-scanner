import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFiles, scanFile, scanPaths, stripFile, stripPaths } from "./files.js";

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
});

describe("stripFile", () => {
  it("returns the source with comments removed without modifying the file by default", async () => {
    const file = join(dir, "a.ts");
    await writeFile(file, "const x = 1; // hi\n");

    const result = await stripFile(file);

    expect(result).toMatchObject({ file, output: "const x = 1;\n", removed: 1, changed: true });
    expect(await readFile(file, "utf8")).toBe("const x = 1; // hi\n");
  });

  it("rewrites the file in place when write is true", async () => {
    const file = join(dir, "a.ts");
    await writeFile(file, "const x = 1; // hi\n");

    await stripFile(file, true);

    expect(await readFile(file, "utf8")).toBe("const x = 1;\n");
  });

  it("reports no change and leaves the file alone when there are no comments", async () => {
    const file = join(dir, "a.ts");
    await writeFile(file, "const x = 1;\n");

    const result = await stripFile(file, true);

    expect(result).toMatchObject({ removed: 0, changed: false });
    expect(await readFile(file, "utf8")).toBe("const x = 1;\n");
  });

  it("keeps compiler directives and counts only the comments it removed", async () => {
    const file = join(dir, "a.ts");
    await writeFile(file, '/// <reference types="node" />\n// gone\nconst x = 1;\n');

    const result = await stripFile(file, true);

    expect(result.removed).toBe(1);
    expect(await readFile(file, "utf8")).toBe('/// <reference types="node" />\nconst x = 1;\n');
  });
});

describe("stripPaths", () => {
  it("strips every collected file and reports per-file results", async () => {
    await writeFile(join(dir, "a.ts"), "// a\nconst x = 1;");
    await writeFile(join(dir, "b.ts"), "const y = 2;");

    const results = await stripPaths([dir]);

    expect(results).toEqual([
      { file: join(dir, "a.ts"), output: "const x = 1;", removed: 1, changed: true },
      { file: join(dir, "b.ts"), output: "const y = 2;", removed: 0, changed: false },
    ]);
  });

  it("writes changes back to disk when write is true", async () => {
    await writeFile(join(dir, "a.ts"), "// a\nconst x = 1;");

    await stripPaths([dir], { write: true });

    expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("const x = 1;");
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

  it("returns results in sorted file order across many files", async () => {
    const names = Array.from({ length: 25 }, (_, index) => `f${String(index).padStart(2, "0")}.ts`);
    await Promise.all(names.map((name) => writeFile(join(dir, name), `// ${name}`)));

    const results = await scanPaths([dir]);

    expect(results.map((result) => result.file)).toEqual(names.map((name) => join(dir, name)));
  });
});
