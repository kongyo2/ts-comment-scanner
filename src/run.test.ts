import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type CliIO } from "./run.js";

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

    expect(code).toBe(0);
    expect(out()).toContain(
      `::notice file=${join(dir, "a.ts")},line=1,endLine=1,col=1,endColumn=6,title=line comment::// hi`,
    );
  });

  it("prints help and returns 0 without scanning", async () => {
    const { io, out } = capture();

    const code = await run(["--help"], io);

    expect(code).toBe(0);
    expect(out()).toContain("Usage: ts-comment-scanner");
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
});
