import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Buffer } from "node:buffer";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectFiles,
  decodeFileText,
  encodeFileText,
  isJsxFile,
  scanFile,
  scanPaths,
  writeFileAtomic,
} from "./files.js";

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

  it("does not traverse an ignored directory passed as an input root", async () => {
    await mkdir(join(dir, "node_modules"), { recursive: true });
    await writeFile(join(dir, "node_modules", "dep.ts"), "// dep\n");

    const files = await collectFiles([join(dir, "node_modules")]);

    expect(files).toEqual([]);
  });

  it("still returns an explicitly listed file inside an ignored directory", async () => {
    // Like the ignore globs, the ignored directory names only guard
    // traversal; naming a file directly is explicit enough.
    await mkdir(join(dir, ".git"), { recursive: true });
    const file = join(dir, ".git", "hook.ts");
    await writeFile(file, "// hook\n");

    const files = await collectFiles([file]);

    expect(files).toEqual([file]);
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

describe("collectFiles with symlinks", () => {
  it("follows a symlinked file found during a directory walk", async () => {
    const real = join(dir, "real");
    const scan = join(dir, "scan");
    await mkdir(real);
    await mkdir(scan);
    await writeFile(join(real, "source.ts"), "// linked\n");
    await symlink(join(real, "source.ts"), join(scan, "link.ts"));

    const files = await collectFiles([scan]);

    expect(files).toEqual([join(scan, "link.ts")]);
  });

  it("follows a symlinked directory found during a directory walk", async () => {
    const real = join(dir, "real");
    const scan = join(dir, "scan");
    await mkdir(real);
    await mkdir(scan);
    await writeFile(join(real, "source.ts"), "// linked\n");
    await symlink(real, join(scan, "linked-dir"));

    const files = await collectFiles([scan]);

    expect(files).toEqual([join(scan, "linked-dir", "source.ts")]);
  });

  it("terminates on circular directory symlinks", async () => {
    await writeFile(join(dir, "a.ts"), "// a\n");
    await symlink(dir, join(dir, "loop"));

    const files = await collectFiles([dir]);

    expect(files).toEqual([join(dir, "a.ts")]);
  });

  it("silently skips broken symlinks during a walk", async () => {
    await writeFile(join(dir, "a.ts"), "// a\n");
    await symlink(join(dir, "gone.ts"), join(dir, "broken.ts"));

    const files = await collectFiles([dir]);

    expect(files).toEqual([join(dir, "a.ts")]);
  });

  it("does not report a directory reached through two symlinks twice", async () => {
    const real = join(dir, "real");
    const scan = join(dir, "scan");
    await mkdir(real);
    await mkdir(scan);
    await writeFile(join(real, "source.ts"), "// linked\n");
    await symlink(real, join(scan, "one"));
    await symlink(real, join(scan, "two"));

    const files = await collectFiles([scan]);

    expect(files).toHaveLength(1);
  });

  it("collapses two file symlinks to one target into a single entry", async () => {
    const real = join(dir, "real");
    const scan = join(dir, "scan");
    await mkdir(real);
    await mkdir(scan);
    await writeFile(join(real, "source.ts"), "// linked\n");
    await symlink(join(real, "source.ts"), join(scan, "a.ts"));
    await symlink(join(real, "source.ts"), join(scan, "b.ts"));

    const files = await collectFiles([scan]);

    expect(files).toHaveLength(1);
  });

  it("collapses a file symlink with its explicitly listed target, keeping the first spelling", async () => {
    const target = join(dir, "target.ts");
    const link = join(dir, "link.ts");
    await writeFile(target, "// once\n");
    await symlink(target, link);

    const files = await collectFiles([link, target]);

    expect(files).toEqual([link]);
  });

  it("skips a symlink that points to itself like any other broken link", async () => {
    await writeFile(join(dir, "a.ts"), "// a\n");
    await symlink(join(dir, "self.ts"), join(dir, "self.ts"));

    const files = await collectFiles([dir]);

    expect(files).toEqual([join(dir, "a.ts")]);
  });
});

describe("collectFiles path identity", () => {
  it("collapses relative and absolute spellings of the same file", async () => {
    const file = join(dir, "a.ts");
    await writeFile(file, "// a\n");
    const previousCwd = process.cwd();
    process.chdir(dir);
    try {
      const files = await collectFiles(["a.ts", file]);
      expect(files).toHaveLength(1);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("applies ignore patterns to directories that merely start with two dots", async () => {
    await mkdir(join(dir, "..hidden"));
    await writeFile(join(dir, "..hidden", "x.ts"), "// hidden\n");
    await writeFile(join(dir, "ok.ts"), "// ok\n");

    const files = await collectFiles([dir], { ignore: ["..hidden/**"] });

    expect(files).toEqual([join(dir, "ok.ts")]);
  });

  it("reports a friendly error for a missing input path", async () => {
    await expect(collectFiles([join(dir, "missing.ts")])).rejects.toThrow(/path not found: .*missing\.ts/);
  });

  it("propagates stat errors other than a missing path unchanged", async () => {
    const file = join(dir, "a.ts");
    await writeFile(file, "// a\n");

    // Windows reports ENOENT (not ENOTDIR) for traversing through a file, so
    // the friendly missing-path message applies there instead.
    const expected = process.platform === "win32" ? /path not found/ : /ENOTDIR/;
    await expect(collectFiles([join(file, "child.ts")])).rejects.toThrow(expected);
  });
});

describe("decodeFileText / encodeFileText", () => {
  it("decodes plain UTF-8 losslessly", () => {
    const decoded = decodeFileText(Buffer.from("// hi\n", "utf8"));

    expect(decoded).toMatchObject({ text: "// hi\n", encoding: "utf8", bom: false, lossless: true });
  });

  it("decodes UTF-8 with a byte-order mark and re-encodes it byte-identically", () => {
    const data = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("// hi\n", "utf8")]);
    const decoded = decodeFileText(data);

    expect(decoded).toMatchObject({ text: "// hi\n", encoding: "utf8", bom: true, lossless: true });
    expect(encodeFileText(decoded.text, decoded).equals(data)).toBe(true);
  });

  it("decodes UTF-16LE and re-encodes it byte-identically", () => {
    const data = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("// こんにちは\n", "utf16le")]);
    const decoded = decodeFileText(data);

    expect(decoded).toMatchObject({ text: "// こんにちは\n", encoding: "utf16le", bom: true, lossless: true });
    expect(encodeFileText(decoded.text, decoded).equals(data)).toBe(true);
  });

  it("decodes UTF-16BE and re-encodes it byte-identically", () => {
    const body = Buffer.from("// hi\n", "utf16le").swap16();
    const data = Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
    const decoded = decodeFileText(data);

    expect(decoded).toMatchObject({ text: "// hi\n", encoding: "utf16be", bom: true, lossless: true });
    expect(encodeFileText(decoded.text, decoded).equals(data)).toBe(true);
  });

  it("marks invalid UTF-8 as lossy", () => {
    const data = Buffer.concat([Buffer.from('const s = "', "utf8"), Buffer.from([0x80]), Buffer.from('";\n', "utf8")]);

    expect(decodeFileText(data).lossless).toBe(false);
  });

  it("marks UTF-16 with a truncated code unit as lossy", () => {
    const data = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("ab", "utf16le"), Buffer.from([0x41])]);

    expect(decodeFileText(data).lossless).toBe(false);
  });

  it("marks truncated UTF-16BE as lossy instead of throwing", () => {
    const body = Buffer.from("ab", "utf16le").swap16();
    const data = Buffer.concat([Buffer.from([0xfe, 0xff]), body, Buffer.from([0x00])]);

    const decoded = decodeFileText(data);

    expect(decoded.encoding).toBe("utf16be");
    expect(decoded.text).toBe("ab");
    expect(decoded.lossless).toBe(false);
  });

  it("omits the byte-order mark when encoding with bom: false", () => {
    expect(encodeFileText("A", { encoding: "utf16le", bom: false }).toString("hex")).toBe("4100");
    expect(encodeFileText("A", { encoding: "utf16be", bom: false }).toString("hex")).toBe("0041");
    expect(encodeFileText("A", { encoding: "utf8", bom: false }).toString("hex")).toBe("41");
  });

  it("emits the byte-order mark when encoding with bom: true", () => {
    expect(encodeFileText("A", { encoding: "utf16le", bom: true }).toString("hex")).toBe("fffe4100");
    expect(encodeFileText("A", { encoding: "utf16be", bom: true }).toString("hex")).toBe("feff0041");
    expect(encodeFileText("A", { encoding: "utf8", bom: true }).toString("hex")).toBe("efbbbf41");
  });
});

describe("scanFile with encodings", () => {
  it("finds comments in a UTF-16LE file", async () => {
    const file = join(dir, "u16.ts");
    await writeFile(
      file,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("// note\nconst x = 1;\n", "utf16le")]),
    );

    const result = await scanFile(file);

    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]).toMatchObject({ text: "// note", start: 0, line: 1, column: 1 });
  });
});

describe("writeFileAtomic", () => {
  it("replaces the content and leaves no temporary files behind", async () => {
    const file = join(dir, "a.ts");
    await writeFile(file, "old");

    await writeFileAtomic(file, Buffer.from("new"));

    expect(await readFile(file, "utf8")).toBe("new");
    expect((await readdir(dir)).sort()).toEqual(["a.ts"]);
  });

  // POSIX permission bits do not round-trip through Windows ACLs, so the
  // assertion only holds on POSIX platforms.
  it.skipIf(process.platform === "win32")("preserves the file mode", async () => {
    const file = join(dir, "a.ts");
    await writeFile(file, "old");
    await chmod(file, 0o640);

    await writeFileAtomic(file, Buffer.from("new"));

    expect(((await stat(file)).mode & 0o777).toString(8)).toBe("640");
  });

  it("writes through a symlink instead of replacing the link", async () => {
    const target = join(dir, "target.ts");
    const link = join(dir, "link.ts");
    await writeFile(target, "old");
    await symlink(target, link);

    await writeFileAtomic(link, Buffer.from("new"));

    expect(await readFile(target, "utf8")).toBe("new");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });
});
