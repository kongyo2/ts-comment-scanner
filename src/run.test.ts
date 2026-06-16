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

  it("returns 1 and writes an error when a path does not exist", async () => {
    const { io, err } = capture();

    const code = await run([join(dir, "missing.ts")], io);

    expect(code).toBe(1);
    expect(err()).toContain("missing.ts");
  });
});
